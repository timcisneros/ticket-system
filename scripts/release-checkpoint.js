#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_RESULT_PARENT,
  executeCheckpoint
} = require('./release-checkpoint-results');

const ROOT = path.resolve(__dirname, '..');

const CHECKPOINT_TEST_SCRIPTS = Object.freeze([
  'bounded-worker-pool-test.js',
  // ── T2 Ticket lifecycle / attempt authority (Tranche 1..5) ──────────────
  't2-lifecycle-contract-test.js',
  't2-attempt-completion-contract-test.js',
  't2-v2-completion-authority-contract-test.js',
  'ticket-cancellation-authority-contract-test.js',
  't2-five-state-classifier-contract-test.js',
  't2-tranche5-blocking-authority-test.js',
  't2-lock-protocol-postgres-test.js',
  't2-lineage-closure-postgres-test.js',
  't2-cancellation-authority-postgres-test.js',
  't2-five-state-classifier-postgres-test.js',
  't2-tranche5-store-postgres-test.js',
  't2-tranche5-migration-postgres-test.js',
  // T2 — preflight-classifier vs migration-hook fact-assembly parity
  // (operational incident T2-041-1). Exercises BOTH real seams.
  't2-five-state-fact-parity-postgres-test.js',
  // T3-a — objective-revision kernel: normalization/hash/provenance contract,
  // activation baseline migration, guarded N->N+1, admission fail-closed
  // integrity, per-attempt Run stamp uniformity.
  't3-objective-revision-contract-test.js',
  't3-objective-revision-postgres-test.js',
  't2-tranche5-release-admission-server-test.js',
  't2-tranche5-rerun-lock-order-test.js',
  't041-semantic-closure-test.js',
  'business-scenario-contracts-test.js',
  'dev-environment-test.js',
  'rotate-session-secret-test.js',
  'catalog-consistency-test.js',
  'completion-decision-contract-test.js',
  'declared-completion-authority-binding-test.js',
  'declared-work-contract-test.js',
  'allocation-plan-v2-contract-test.js',
  'structured-allocation-prerequisites-contract-test.js',
  'structured-allocation-planning-contract-test.js',
  'structured-allocation-leaf-run-contract-test.js',
  'execution-target-registry-test.js',
  'economic-authority-contract-test.js',
  'economic-settlement-receipt-contract-test.js',
  'governed-leaf-slice-boundary-test.js',
  'verified-progress-contract-test.js',
  'postcondition-criterion-evaluator-test.js',
  'governed-eligible-facts-test.js',
  'governed-fact-transitions-test.js',
  'agent-run-draft-test.js',
  'test-server-startup-contract-test.js',
  'governed-openai-transport-hermetic-test.js',
  'governed-openai-transport-test.js',
  'governed-planner-cutover-boundary-test.js',
  'governed-policy-source-test.js',
  'governed-role-economic-policy-set-test.js',
  // Tranche 6 — the shared per-trial observation sink. Deterministic: it
  // touches only temporary directories.
  'evaluation-observation-sink-test.js',
  // Tranche 6 — the frozen scored-run manifest. Deterministic: config only.
  'evaluation-scored-manifest-test.js',
  // Tranche 6 — retained fixture evidence means actual repository-owned bytes,
  // never an in-memory capsule of recorded hashes.
  'evaluation-fixture-evidence-test.js',
  // Tranche 6 — live-model readiness. Deterministic: config only, no provider.
  'evaluation-live-readiness-test.js',
  // Tranche 6 — complete provider-free post-corpus scoring/report rehearsal.
  'evaluation-live-scoring-dress-rehearsal-test.js',
  // Tranche 6 — actual production report CLI + retained fixture-v2 closure.
  'evaluation-live-production-closure-test.js',
  // Tranche 6 — every accepted REAL product artifact has a frozen scoring,
  // exclusion, or pre-acceptance refusal disposition.
  'evaluation-live-artifact-domain-test.js',
  // Tranche 6 — source-derived equivalence classes for every metric-affecting
  // candidate dimension, separate from the runner's mixed examples.
  'evaluation-live-candidate-domain-totality-test.js',
  // Tranche 6 — actual live topology reaches RETAIN/REVISE/STOP without a provider.
  'evaluation-live-decision-topology-test.js',
  // Tranche 6 — the frozen live manifest and its guards. No provider call.
  'evaluation-live-manifest-test.js',
  // Tranche 6 — the durable global live budget ceiling. No provider call.
  'evaluation-live-budget-test.js',
  // Tranche 6 — the live matrix executor's refusals. Deterministic, no server.
  'evaluation-live-matrix-contract-test.js',
  // Tranche 6 — the live artifact's durable-observation projection: what an
  // operator can still distinguish once the ephemeral database is gone.
  'evaluation-live-observation-projection-test.js',
  // Tranche 6 — the transport-observation contract, at the module that owns it.
  'provider-transport-observation-test.js',
  // Tranche 6 — the scored executor and pure scorer. Deterministic: config only.
  'structured-allocation-scored-evaluation-test.js',
  'governed-provider-transport-test.js',
  'governed-provider-request-contract-test.js',
  'model-pricing-catalog-test.js',
  'provider-adapter-capability-test.js',
  'role-routing-contract-test.js',
  'mixed-family-work-model-test.js',
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
  'process-deployment-systemd-test.js',
  'process-execution-release-contract-test.js',
  'process-execution-release-health-test.js',
  'process-launch-plan-test.js',
  'process-release-ga-evidence-contract-test.js',
  'process-launcher-foundation-contract-test.js',
  'process-launcher-foundation-deployment-test.js',
  'process-launcher-foundation-native-test.js',
  'process-launcher-retention-test.js',
  'process-launcher-foundation-cross-uid-test.js',
  'process-materializer-contract-test.js',
  'process-materializer-deployment-test.js',
  'process-materializer-native-test.js',
  'process-materializer-linux-test.js',
  'process-materializer-cross-uid-test.js',
  'process-output-artifact-test.js',
  'process-runtime-capability-test.js',
  'process-runtime-fault-recovery-test.js',
  'process-supervision-contract-test.js',
  'process-target-catalog-test.js',
  'release-manifest-test.js',
  'release-package-test.js',
  'third-party-notices-test.js',
  'release-security-check-test.js',
  'postgres-persistence-contract-test.js',
  'recovery-state-reconstruction-test.js',
  'run-decision-graph-projection-test.js',
  'runtime-budget-contract-test.js',
  'scheduler-observability-test.js',
  'workspace-fixture-catalog-test.js',
  'workspace-snapshot-availability-test.js',
  'run-evidence-drain-test.js',
  'release-checkpoint-coverage-test.js',
  // Canonical checkpoint evidence must survive terminal/session loss. This
  // deterministic suite drives the real recorder through pass, fail-fast,
  // and interrupted orchestration paths.
  'release-checkpoint-results-test.js',
  // A20 — deterministic suites that pass today and were never registered. Nothing
  // was wrong with them; nothing ran them either, which is the same gap that let the
  // cutover orphans rot unnoticed. scripts/test-manifest.js now classifies every
  // test file, and the coverage test fails if a required one is missing here.
  'telemetry-test.js',
  'typed-evidence-projection-test.js',
  'workload-profile-test.js',
  'archive-local-events-test.js',
  'mutating-limit-context-regression-test.js',
  // A20 tranche 2 — the shared child-settlement helper that removes the
  // silent-success failure mode from the orphaned suites. Deterministic: it spawns
  // only short-lived `node -e` children.
  'child-process-settlement-test.js',
  // Tranche 6 — the controlled-evaluation harness proofs. Deterministic: it
  // touches only the filesystem and pure contracts, and needs no database.
  'structured-allocation-evaluation-test.js'
]);

const POSTGRES_INTEGRATION_SCRIPTS = Object.freeze([
  // Tranche 6 — one active governed container funding both canonical roles,
  // proved against real persistence and a fresh connection.
  'governed-role-policy-container-postgres-test.js',
  // Tranche 6 — scenario families executed through the real server.
  'structured-allocation-scenario-postgres-test.js',
  // Tranche 6 — the governed unexpected-request negative control.
  'governed-evaluation-negative-path-postgres-test.js',
  // Tranche 6 — the live dispatch acceptance proof. Captures the final network
  // hop; makes zero external calls.
  'structured-allocation-live-dispatch-postgres-test.js',
  'structured-allocation-live-matrix-postgres-test.js',
  // Tranche 6 — actual runner-produced failure shapes mixed into the complete
  // production scoring/report command. Controlled boundary, zero provider.
  'evaluation-live-artifact-domain-postgres-test.js',
  // Tranche 6 post-result release validation: a terminal Ticket may not make
  // the evaluator observe quiescence while its child evidence writer is live.
  'evaluation-reader-quiescence-postgres-test.js',
  'evaluation-live-credential-postgres-test.js',
  // Tranche 6 — the durable provider-transport observation, on both production
  // transports and all three roles. Replaces the final hop; zero external calls.
  'provider-transport-invocation-postgres-test.js',
  // Tranche 6 — the ungoverned pipeline against the REAL Responses envelope:
  // one valid action to a receipt, four over the cap to a product refusal.
  'ungoverned-real-envelope-pipeline-postgres-test.js',
  // Kernel-owned topology-neutral attempt identity, atomic membership,
  // settlement/projection, retry/resume, and database constraints.
  'ticket-attempt-authority-postgres-test.js',
  // Real pre-039 schema plus source-owned v1/v2/singleton backfill/refusal.
  'ticket-attempt-backfill-postgres-test.js',
  'postgres-persistence-integration-test.js',
  'postgres-runtime-cutover-test.js',
  'page-render-regression-test.js',
  'postgres-startup-recovery-test.js',
  'provider-response-recovery-postgres-test.js',
  'process-execution-runtime-test.js',
  'process-execution-release-postgres-test.js',
  'process-execution-release-soak-test.js',
  'process-release-backup-restore-test.js',
  'process-lease-expiry-cancellation-postgres-test.js',
  'process-consequence-reconstruction-test.js',
  'process-runtime-lifecycle-postgres-test.js',
  'process-runtime-dispatch-postgres-test.js',
  'process-supervision-postgres-test.js',
  'process-workspace-mutation-boundary-test.js',
  'lease-renewal-resume-safety-test.js',
  'model-contract-violation-test.js',
  'model-contract-violation-recovery-test.js',
  'execution-semantics-persistence-test.js',
  'workspace-snapshot-recovery-test.js',
  'operation-receipt-projection-test.js',
  'run-consequence-mutation-test.js',
  'required-replay-evidence-test.js',
  'delegated-run-logging-containment-test.js',
  'declared-work-postgres-test.js',
  'allocation-plan-v2-postgres-test.js',
  'structured-allocation-prerequisites-postgres-test.js',
  'structured-allocation-activation-retirement-postgres-test.js',
  'structured-allocation-planning-postgres-test.js',
  'structured-allocation-planner-provider-test.js',
  'structured-allocation-leaf-run-postgres-test.js',
  'economic-accounting-schema-postgres-test.js',
  'economic-accounting-store-postgres-test.js',
  'governed-leaf-authority-postgres-test.js',
  'governed-execution-projection-postgres-test.js',
  'governed-leaf-production-path-postgres-test.js',
  'verified-progress-projection-postgres-test.js',
  'governed-postcondition-evidence-postgres-test.js',
  'governed-verified-progress-credit-postgres-test.js',
  'governed-leaf-first-response-postgres-test.js',
  'governed-transport-correlation-test.js',
  'governed-request-claim-classification-test.js',
  'governed-sibling-dependency-postgres-test.js',
  'auto-retry-attempt-ceiling-test.js',
  'malformed-completion-binding-postgres-test.js',
  'verified-progress-terminal-mapping-test.js',
  'governed-verified-progress-lifecycle-postgres-test.js',
  'governed-no-progress-withholding-postgres-test.js',
  'governed-evidence-integrity-postgres-test.js',
  'governed-authorized-restart-postgres-test.js',
  'governed-blocked-restart-postgres-test.js',
  'governed-pre-transport-restart-postgres-test.js',
  'governed-post-transport-restart-postgres-test.js',
  'governed-replay-corruption-postgres-test.js',
  'governed-required-persistence-postgres-test.js',
  'structured-allocation-evaluation-runner-postgres-test.js',
  'malformed-completion-projection-postgres-test.js',
  'governed-planner-dispatch-postgres-test.js',
  'governed-planner-production-path-postgres-test.js',
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
  'runtime-budget-postgres-test.js',
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
  'completion-decision-postgres-test.js',
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
  'typed-projection-parity-postgres-test.js',
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
  // maxAttempts is a future-admission policy, independent of the parent Ticket's
  // terminal status projection. Force finalization between the route's read and
  // write so that independence is proved without a timing race.
  'max-attempts-finalization-race-test.js',
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

function buildCheckpointChecks() {
  return [
    { owner: 'check-js-syntax.js', category: 'syntax' },
    ...CHECKPOINT_TEST_SCRIPTS.map(owner => ({ owner, category: 'deterministic' })),
    ...POSTGRES_INTEGRATION_SCRIPTS.map(owner => ({ owner, category: 'postgres' }))
  ].map(check => ({
    ...check,
    sourcePath: path.join(ROOT, 'scripts', check.owner),
    command: process.execPath,
    args: [path.join('scripts', check.owner)],
    cwd: ROOT
  }));
}

async function runCheckpoint({
  environment = process.env,
  resultParent = environment.RELEASE_CHECKPOINT_RESULTS_ROOT || DEFAULT_RESULT_PARENT
} = {}) {
  if (!environment.TEST_DATABASE_URL) {
    console.error('CHECKPOINT FAILED: TEST_DATABASE_URL is required for the Postgres release checkpoint');
    return 1;
  }
  const allScripts = [...CHECKPOINT_TEST_SCRIPTS, ...POSTGRES_INTEGRATION_SCRIPTS];
  const missing = allScripts.filter(name => !fs.existsSync(path.join(ROOT, 'scripts', name)));
  if (missing.length) {
    console.error(`CHECKPOINT FAILED: missing test scripts: ${missing.join(', ')}`);
    return 1;
  }
  const startedAt = Date.now();
  const execution = await executeCheckpoint({
    root: ROOT,
    checks: buildCheckpointChecks(),
    environment: { ...environment, NODE_ENV: environment.NODE_ENV || 'test' },
    resultParent
  });
  if (execution.terminal.state === 'FAILED') {
    console.error(`\nCHECKPOINT FAILED: ${execution.terminal.firstFailedOwner} ` +
      `(${execution.terminal.failureResult.toLowerCase()}` +
      `${execution.terminal.signal ? ` ${execution.terminal.signal}` : ` exit ${execution.terminal.exitCode}`})`);
    console.error(`${execution.terminal.passedCount}/${execution.terminal.totalCount} checks passed before the failure.`);
    console.error(`Durable checkpoint result: ${execution.runRoot}`);
    return execution.exitCode;
  }
  console.log(`\nRELEASE CHECKPOINT PASSED: ${execution.terminal.passedCount}/${execution.terminal.totalCount} checks in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`Durable checkpoint result: ${execution.runRoot}`);
  return 0;
}

module.exports = {
  CHECKPOINT_TEST_SCRIPTS,
  POSTGRES_INTEGRATION_SCRIPTS,
  buildCheckpointChecks,
  runCheckpoint
};

if (require.main === module) {
  runCheckpoint()
    .then(exitCode => { process.exitCode = exitCode; })
    .catch(error => {
      console.error(`CHECKPOINT ORCHESTRATION FAILED: ${error.message}`);
      process.exitCode = 1;
    });
}
