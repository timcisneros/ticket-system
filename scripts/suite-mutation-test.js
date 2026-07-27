#!/usr/bin/env node
'use strict';
// Restored-suite mutation test
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10 and A20).
//
// WHY THIS EXISTS. A migrated suite that runs and prints "PASS" has proved only that
// it no longer errors. It has NOT proved that it would still catch the regression it
// was written to catch — and the A10 tranche found exactly that failure in a suite
// already recorded as restored: `startup-data-integrity-test.js` omitted
// SESSION_SECRET, so both its scenarios exited non-zero because the server could not
// boot at all, and all eight assertions passed without ever exercising a storage
// fault. A suite can be green and vacuous at the same time.
//
// A20 then found the same disease in a different form: seven suites that exit ZERO
// while asserting nothing, because their cleanup awaits an exit event from an
// already-dead child and the .catch() never runs. Vacuity is not an accident that
// happened once; it is a recurring shape, so it needs a standing check.
//
// This script closes that gap the only way that actually settles it: it breaks the
// runtime on purpose, one contract at a time, and requires the corresponding suite to
// FAIL. A mutation that leaves its suite green is a coverage hole, reported as such.
//
// DELIBERATELY NOT IN THE RELEASE CHECKPOINT. It edits tracked source files in place.
// It is an audit tool, run explicitly:
//
//   TEST_DATABASE_URL=... node scripts/suite-mutation-test.js [suite-name ...]
//
// SAFETY. Source is restored in a `finally` and on SIGINT/SIGTERM, and the restore is
// verified by SHA-256 against the bytes read before mutating. The run REFUSES TO START
// if any target file already has uncommitted changes, so a crash can never be confused
// with, or destroy, work in progress.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the suite mutation test');
  process.exit(1);
}

// Each mutation names the SINGLE contract it removes. `find` must occur exactly once
// in the file, so a mutation can never land somewhere other than where it was aimed.
const MUTATIONS = Object.freeze([
  {
    name: 'startup-fails-open',
    suite: 'startup-data-integrity-test.js',
    file: 'server.js',
    contract: 'a startup guard failure exits non-zero (fail closed)',
    find: '    process.exitCode = 1;',
    replace: '    process.exitCode = 0;',
    // A supervisor reads the exit code. Reporting success after refusing to start is
    // the regression that turns a storage fault into a silently degraded deployment.
    //
    // An earlier attempt aimed this mutation at the required-relation list in
    // persistence/postgres/store.js and it SURVIVED — not because the suite was
    // vacuous, but because dropping access_users also breaks bootstrap, which fails
    // closed independently. That is defense in depth, so removing one layer does not
    // remove the contract. The lesson is recorded here because a surviving mutation
    // means one of two different things, and only one of them is a coverage hole.
    //
    // The suite's other half — "no default administrator is created from unusable
    // state" — is guarded by its own scenario 0 positive control, which requires the
    // "Default admin user created" line to APPEAR on a healthy start. That makes its
    // absence in the refusal scenarios evidence rather than an accident.
    expect: 'an unusable store produces a zero exit code'
  },
  {
    name: 'mutating-action-cap',
    suite: 'bounded-transition-test.js',
    file: 'server.js',
    contract: 'a response may propose at most 2 mutating actions',
    find: "parseInt(process.env.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || '2', 10) || 2",
    replace: "parseInt(process.env.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || '8', 10) || 8",
    expect: 'the oversized three-mutation batch is accepted instead of rejected whole'
  },
  {
    name: 'renamepath-conflict-carveout',
    suite: 'renamepath-runtime-regression-test.js',
    file: 'persistence/postgres/store.js',
    contract: 'renamePath may consume a path this run created',
    // Replaces the whole query tail, not just the carve-out clause: dropping the
    // clause alone would leave $5/$6 bound and the query would fail to parse, killing
    // the suite for a reason that proves nothing. The mutation must yield a VALID
    // query that simply lacks the carve-out.
    find: "         AND NOT ($5::text = 'renamePath' AND operation = ANY($6::text[]))\n"
      + '       ORDER BY id\n'
      + '       LIMIT 1`,\n'
      + "      [id, target, workspacePath, mutationFingerprint, operationName, ['writeFile', 'createFolder']]",
    replace: '       ORDER BY id\n'
      + '       LIMIT 1`,\n'
      + '      [id, target, workspacePath, mutationFingerprint]',
    expect: 'writeFile-then-renamePath is rejected as a conflict'
  },
  {
    name: 'diagnostic-count-wording',
    suite: 'run-diagnostics-bundle-test.js',
    file: 'server.js',
    contract: 'count wording is status-aware ("before failure" only for failed runs)',
    find: "  const countSuffix = runFailed ? ' before failure' : '';",
    replace: "  const countSuffix = '';",
    expect: 'a failed run reports its counts with neutral wording'
  },
  {
    name: 'cross-ticket-delete-gate',
    suite: 'concurrency-conflict-test.js',
    file: 'server.js',
    contract: 'a cross-ticket delete requires workspace.delete.cross_ticket_artifact',
    // Drop the permission test from the gate: every delegated user is now treated as
    // holding the permission, so an unpermitted cross-ticket delete succeeds. This is
    // an authorization bypass, and the suite must refuse to stay green through it.
    find: "  if (operation === 'deletePath' && run && run.delegatedUserId != null "
      + '&& await userHasPermission(run.delegatedUserId, CROSS_TICKET_DELETE_PERMISSION)) {',
    replace: "  if (operation === 'deletePath' && run && run.delegatedUserId != null) {",
    expect: 'a user without the permission can delete another ticket\'s artifact'
  },
  {
    name: 'permissioned-delete-block-unconditional',
    suite: 'run-detail-permissioned-delete-audit-test.js',
    file: 'views/run-detail.ejs',
    contract: 'the permissioned-delete block renders only when the permission was used',
    // The positive half of that suite would still pass here; only the negative half
    // catches it. That is the point — a block that always renders attests to an
    // authorization that never happened.
    find: "  <% if (typeof permissionedDeleteAuditEvents !== 'undefined' "
      + '&& permissionedDeleteAuditEvents && permissionedDeleteAuditEvents.length > 0) { %>',
    replace: '  <% if (true) { %>',
    expect: 'the audit block renders on runs that never exercised the permission'
  },
  {
    name: 'reassess-context-always-injected',
    suite: 'rerun-mode-evidence-test.js',
    file: 'server.js',
    contract: 'prior-failure context is injected for reassess mode only',
    // Inject the prior failure into every rerun, not only reassess. Only the suite's
    // RETRY half catches this — which is the half the retired source-extraction test
    // could not express at all, because a substring match on server.js cannot tell
    // when a function is called.
    find: "        actionResults.length === 0 && rerunMode === 'reassess'",
    replace: '        actionResults.length === 0',
    expect: 'a default retry silently receives the previous run\'s failure evidence'
  },
  {
    name: 'poststate-echoes-request',
    suite: 'operation-poststate-observation-test.js',
    file: 'server.js',
    contract: 'post-state is captured by observing the filesystem',
    // Make capture a no-op so nothing is observed. A receipt that reports no observed
    // state is the mildest possible version of "stopped observing"; a suite that
    // cannot notice even this is not testing observation at all.
    find: 'function captureWorkspacePostState(',
    replace: 'function captureWorkspacePostState() { return null; }\nfunction __unusedCaptureWorkspacePostState(',
    expect: 'operation receipts carry no observed post-state'
  },
  {
    name: 'owned-path-scope-broadened',
    suite: 'allocation-scope-authority-test.js',
    file: 'server.js',
    contract: 'an allocated run may mutate only inside its own owned paths',
    // Broaden the containment check so every path counts as owned. Admission still
    // works and the in-scope positive control stays green — only the out-of-scope
    // scenario catches an allocated agent writing into a peer's territory.
    find: '    return normalizedPath === normalizedOwnedPath.slice(0, -1) || normalizedPath.startsWith(normalizedOwnedPath);',
    replace: '    return Boolean(normalizedOwnedPath) || normalizedPath === normalizedPath;',
    expect: 'an allocated run writes outside its owned scope unopposed'
  },
  {
    name: 'authority-denial-loses-its-rule',
    suite: 'timeline-authority-evidence-test.js',
    file: 'server.js',
    contract: 'a timeline authority denial names the rule that refused it',
    // RE-AIMED. This previously stripped the rule from `createWorkspaceViolationItem`
    // (~6528), which feeds `run.violation_detected` — a DIFFERENT evidence channel. The
    // timeline reads `rule: payload.rule` off the durable `authority.denied` event, so
    // the mutation changed a layer the projection never consults and survived. It now
    // targets the call that actually builds that payload.
    //
    // The denial still happens and the entry still appears; only the structured
    // attribution is lost, so a suite asserting merely "a denial exists" stays green
    // while the operator surface can no longer say WHY anything was refused.
    find: `      const evidence = buildAuthorityEvidence(run, operation, pathItem.path, 'denied', 'protected_path', matchedProtectedPattern);`,
    replace: `      const evidence = buildAuthorityEvidence(run, operation, pathItem.path, 'denied', null, matchedProtectedPattern);`,
    expect: 'the timeline shows a refusal it cannot attribute to any rule'
  },
  {
    // The highest-stakes reconciliation boundary in the system: startup deciding what a
    // finished run PROVED. A failed run finalized as completed is a durable lie that no
    // later step revisits.
    name: 'startup-converges-failed-run-to-completed',
    suite: 'startup-state-convergence-test.js',
    file: 'server.js',
    contract: 'startup convergence finalizes a stuck ticket to its run\'s ACTUAL terminal status',
    find: '      updated = await finalizeTicketForRun(latestRun, latestRun.status);',
    replace: '      updated = await finalizeTicketForRun(latestRun, \'completed\');',
    expect: 'a ticket whose run failed is converged to completed on startup'
  },
  {
    // Guards the negative control: convergence must never run while execution could
    // still be in flight, or startup terminalizes work the scheduler is about to do.
    name: 'startup-finalizes-ticket-with-live-run',
    suite: 'startup-state-convergence-test.js',
    file: 'server.js',
    contract: 'a ticket with a pending or running run is never finalized by startup convergence',
    find: "    if (ticketRuns.some(run => ['pending', 'running'].includes(run.status))) continue;",
    replace: '    if (false) continue;',
    expect: 'a ticket with live in-flight work is finalized from a sibling terminal run'
  },
  {
    // Proves the verification refusal is falsifiable. The historical assertion was
    // twice mis-fixtured before the gate was read properly, so it earns a mutation.
    name: 'completion-ignores-required-verification',
    suite: 'completion-admission-test.js',
    file: 'server.js',
    contract: 'a run with a declared verification contract needs a passing verdict before completion',
    find: '  if (isRunVerificationRequired(latestRun)) {',
    replace: '  if (false) {',
    expect: 'a ticket completes with declared verification and no passing verdict'
  },
  {
    // The core of the whole cluster: verification must read the run's captured
    // contract. Emptying the postcondition list is exactly what a runtime honouring a
    // RELAXED live workflow would see — the laundering direction.
    name: 'verification-honours-relaxed-live-contract',
    suite: 'verification-contract-authority-test.js',
    file: 'server.js',
    contract: 'postconditions are verified from the run-start snapshot, not from current workflow state',
    find: '    postconditions: capturedContract.postconditions',
    replace: '    postconditions: []',
    expect: 'a run that violated its original contract is reconciled as passing'
  },
  {
    // The misleading-configuration guard. Without it a template author asking for a
    // stronger verification mode is silently downgraded and never told.
    name: 'template-policy-silently-downgraded',
    suite: 'verification-contract-authority-test.js',
    file: 'server.js',
    contract: 'a template declaring an unsupported requireVerification is refused, not silently normalized',
    find: '  try { assertSupportedRequireVerification(tt.executionPolicy); }\n  catch (error) { reply.code(400); return { error: error.message }; }',
    replace: '  // guard removed',
    expect: 'an unsupported requireVerification is accepted and silently downgraded'
  },
  {
    // Partial persistence: the oversized record is written anyway, after the size check
    // has already reported it as too large. This is the failure the store's transaction
    // boundary exists to prevent.
    name: 'oversized-record-partially-persisted',
    suite: 'event-record-limit-containment-test.js',
    file: 'persistence/postgres/store.js',
    contract: 'a record exceeding the limit is rejected without being stored',
    find: '      const error = new RangeError(`${label} exceeds the configured maximum of ${this.maxJsonRecordBytes} bytes`);',
    replace: '      const error = new RangeError(`${label} exceeds the configured maximum of ${this.maxJsonRecordBytes} bytes`); return record;',
    expect: 'an oversized record is accepted and stored instead of rejected'
  },
  {
    // The same distinction collapsed the other way: a genuine internal
    // evidence-persistence failure is reported as a client error and the runtime keeps
    // going, mutating the world while unable to record any of it.
    name: 'evidence-failure-treated-as-client-error',
    suite: 'event-record-limit-containment-test.js',
    file: 'server.js',
    contract: 'a genuine evidence-persistence failure latches and fails closed',
    // Anchored on the assignment plus the readiness clear, which together are unique to
    // appendEvent — the same assignment also appears in the shutdown path at ~26802.
    find: '    if (!evidencePersistenceFailure) evidencePersistenceFailure = error;\n    serverReady = false;',
    replace: '    if (false) evidencePersistenceFailure = error;\n    serverReady = false;',
    expect: 'an internal evidence-persistence failure leaves the process reporting itself healthy'
  },
  {
    // Removes the transient-conflict retry, restoring the captured root cause of the
    // runtime liveness incident: one routine 40P01 reaches the server, which latches
    // evidence persistence and stops every scheduler.
    name: 'transient-conflict-not-retried',
    suite: 'event-append-lock-order-test.js',
    file: 'persistence/postgres/store.js',
    contract: 'a self-owned evidence append retries PostgreSQL transient transaction conflicts',
    find: '    return this._retryTransientTransaction(() => this.withTransaction(execute));',
    replace: '    return this.withTransaction(execute);',
    expect: 'a routine deadlock surfaces as an evidence-persistence failure'
  },
  {
    // Opens the deployment-wide operational picture to any authenticated principal.
    // The endpoint still answers and still returns correct data, so only a suite that
    // exercises a principal WITHOUT ops:read notices.
    name: 'ops-summary-permission-open',
    suite: 'operational-summary-readonly-test.js',
    file: 'server.js',
    contract: 'the operational summary API is gated on ops:read',
    find: "  if (!hasPermission(request.session.userId, 'ops:read')) { reply.code(403); return { error: 'Permission denied' }; }\n  return { ok: true, summary: await buildOperationalSummary() };",
    replace: '  return { ok: true, summary: await buildOperationalSummary() };',
    expect: 'a principal without ops:read receives the deployment-wide summary'
  },
  {
    // The composition layer that carries prior-turn evidence into the next request.
    // Everything else keeps working — the first turn's operations still execute, replay
    // still records them, and later model calls still happen — but the model is no
    // longer told what it already did, so a bounded run cannot converge.
    name: 'carried-evidence-dropped-from-prompt',
    suite: 'carried-evidence-preservation-test.js',
    file: 'server.js',
    contract: 'each model turn is told what the previous turn did and why it was asked again',
    find: `  if (Array.isArray(previousActionResults) && previousActionResults.length > 0) {
    compact.previousActionResults = previousActionResults;
  }`,
    replace: '  // carried evidence removed',
    expect: 'a later turn no longer knows what the earlier turn did'
  },
  {
    // The fold is protected by TWO layers that both key off `evidenceKey`: the replay
    // pass skips a key the event pass already used, and `addEntry` merges entries
    // sharing a `dedupeKey` derived from it. Removing either alone leaves the other
    // folding — both earlier aims survived for that reason. Changing how the replay side
    // COMPUTES the key defeats both at once, and is the realistic regression: someone
    // alters the key format on one side only.
    name: 'timeline-double-reports-operations',
    suite: 'timeline-receipt-projection-test.js',
    file: 'server.js',
    contract: 'an operation recorded in both the event journal and replay renders once',
    find: '      const evidenceKey = `${run.id}:${operationInfo.operation}:${operationInfo.path}:${receipt && receipt.timestamp ? receipt.timestamp : item.startedAt || index}`;',
    replace: '      const evidenceKey = `${run.id}:${operationInfo.operation}:${operationInfo.path}:${index}:${receipt && receipt.timestamp ? receipt.timestamp : item.startedAt || index}`;',
    expect: 'the timeline reports the same operation twice'
  },
  {
    // Narrows preflight to the FIRST action only, so a batch whose invalid action comes
    // later passes admission and executes its valid prefix before failing. The rejection
    // is still recorded and the corrected turn still recovers — the only difference is a
    // real folder left behind by a batch the runtime calls rejected.
    name: 'preflight-executes-valid-prefix',
    suite: 'action-batch-preflight-test.js',
    file: 'server.js',
    contract: 'the whole action batch is validated before any action executes',
    find: '      const invalidActions = validateWorkspaceActionBatch(actions);',
    replace: '      const invalidActions = validateWorkspaceActionBatch(actions).filter(item => item.actionIndex === 0);',
    expect: 'a valid prefix executes before the invalid action is rejected'
  },
  {
    // Collapses the two 503s into one. A momentarily full but HEALTHY deployment would
    // tell callers the deployment cannot record evidence at all, and an operator would
    // restart a system that only needed a second.
    name: 'backpressure-reported-as-fatal',
    suite: 'mutation-admission-backpressure-test.js',
    file: 'server.js',
    contract: 'a full admission queue is refused as recoverable, not as a persistence failure',
    find: `        code: 'MUTATION_ADMISSION_BACKPRESSURED'`,
    replace: `        code: 'EVENT_PERSISTENCE_UNAVAILABLE'`,
    expect: 'transient fullness is reported with the fatal persistence code'
  },
  {
    // Removes the Retry-After that makes the refusal actionable. The caller is told to
    // go away with no indication the condition clears by itself.
    name: 'backpressure-omits-retry-after',
    suite: 'mutation-admission-backpressure-test.js',
    file: 'server.js',
    contract: 'a backpressure refusal tells the caller to retry',
    find: "      reply.header('Retry-After', '1');\n      reply.code(503);",
    replace: '      reply.code(503);',
    expect: 'a recoverable refusal gives the caller no retry signal'
  },
  {
    // Restores the lock-order inversion: the chain tip is taken before the run row, so a
    // concurrent evidence writer holding the run row deadlocks instead of waiting.
    name: 'event-append-restores-lock-inversion',
    suite: 'event-append-lock-order-test.js',
    file: 'persistence/postgres/store.js',
    contract: 'every evidence writer takes the run row before the event chain tip',
    find: `      await client.query(
        \`SELECT 1 FROM \${this.table('runs')} WHERE id = $1 FOR KEY SHARE\`,
        [runId]
      );`,
    replace: '      // lock-order guard removed',
    expect: 'a concurrent append deadlocks instead of waiting for the run row'
  },
  {
    name: 'completion-ignores-unresolved-triage',
    suite: 'completion-admission-test.js',
    file: 'server.js',
    contract: 'a ticket cannot be manually completed while its latest run requires triage',
    // Let an operator mark a ticket completed over an unresolved triage flag. The
    // other refusals still fire and the positive control still passes, so only the
    // triage scenario catches a durable "completed" claim over work nobody reviewed.
    find: '  if (latestRun.triage && latestRun.triage.required) {',
    replace: '  if (false) {',
    expect: 'a ticket is marked completed while its run still requires triage'
  },
  {
    name: 'inline-script-escaping-removed',
    suite: 'inline-data-injection-test.js',
    file: 'server.js',
    contract: 'operator text embedded in an inline script block is script-context escaped',
    // Stop escaping `<`. An agent named `</script><img …>` then terminates the data
    // block early and its markup becomes live in the page's own origin. The page still
    // renders and every other assertion holds — only the injection checks catch it.
    find: "    .replace(/</g, '\\\\u003c')\n",
    replace: '',
    expect: 'a hostile agent name closes the script block and injects markup'
  },
  {
    name: 'agents-api-leaks-provider-key',
    suite: 'inline-data-injection-test.js',
    file: 'server.js',
    contract: 'the agents API does not serialize provider credentials',
    // Return the raw agent record instead of the public projection. Every agent's API
    // key is then handed to any client permitted to list agents.
    find: '  return { agents: page.agents.map(publicConfiguredAgent), nextAfterId: page.nextAfterId };',
    replace: '  return { agents: page.agents, nextAfterId: page.nextAfterId };',
    expect: 'provider API keys are serialized to every agent-list caller'
  },
  {
    name: 'permission-grant-escalation-open',
    suite: 'permission-escalation-boundary-test.js',
    file: 'server.js',
    contract: 'granting permissions requires permission:assign',
    // A principal with group:create but not permission:assign can then mint a group
    // carrying any permission — and add itself. This is self-promotion, and the
    // positive controls stay green through it, so only the refusal half catches it.
    find: "  if (normalizedPermissions.length > 0 && !hasPermission(request.session.userId, 'permission:assign')) {",
    replace: '  if (false) {',
    expect: 'a partial admin mints a group carrying a permission it does not hold'
  },
  {
    name: 'crashed-runs-never-reclaimed',
    suite: 'terminalization-boundary-recovery-test.js',
    file: 'server.js',
    contract: 'a run abandoned by a dead process is reclaimed once its lease expires',
    // Aimed at the recoverable-run scan the SCHEDULER uses, not at
    // interruptStaleRunsOnStartup. An earlier attempt disabled startup recovery and
    // survived: a run abandoned by a dead process is reclaimed when its lease expires,
    // which the scheduler does on its own interval. Defense in depth — cut the layer
    // that actually reclaims.
    find: `    const page = await repository.listRecoverableRuns({ mode, afterId, limit });
    runs.push(...(page && Array.isArray(page.runs) ? page.runs : []));`,
    replace: `    const page = await repository.listRecoverableRuns({ mode, afterId, limit });
    runs.push();`,
    expect: 'a crashed run is never reclaimed after restart'
  },
  {
    name: 'terminalization-not-atomic',
    suite: 'terminalization-boundary-recovery-test.js',
    file: 'server.js',
    contract: 'a run reaching terminalization records its consequence',
    // Terminalize without the consequence. The run goes terminal, so the suite's
    // status assertions still pass; only the consequence cross-check catches it.
    find: '      return buildRunConsequence(projectedRun, {',
    replace: '      return null && buildRunConsequence(projectedRun, {',
    expect: 'a terminal run carries no consequence'
  },
  {
    name: 'reconcile-under-divergence',
    suite: 'target-operation-reconciliation-test.js',
    file: 'server.js',
    contract: 'a prepared effect is reconciled only when the world still matches the intent',
    // Treat an UNCERTAIN target as applied. Recovery then manufactures a receipt for an
    // effect nobody can prove this run produced, over state a third party changed.
    // The applied scenario still passes — only the refusal half catches it.
    // Anchored on reconcilePreparedTargetOperation — the STARTUP recovery path.
    // `reconciliation.status === 'uncertain'` appears three times on three different
    // paths; an earlier attempt aimed at beginWorkspaceMutation's in-run branch and
    // survived, because a crashed run is reconciled by startup recovery, not by the
    // in-run begin path. Defense in depth again: the layer that fires is the one to cut.
    find: `  const reconciliation = classifyPreparedWorkspaceMutation(getRunWorkspaceProvider(run), intent);
  if (reconciliation.status === 'not_applied') return 'not_applied';
  if (reconciliation.status === 'uncertain') {`,
    replace: `  const reconciliation = classifyPreparedWorkspaceMutation(getRunWorkspaceProvider(run), intent);
  if (reconciliation.status === 'not_applied') return 'not_applied';
  if (false) {`,
    expect: 'divergent state is reconciled and a receipt is fabricated'
  },
  {
    name: 'action-plan-allowlist-ignored',
    suite: 'workflow-action-plan-test.js',
    file: 'server.js',
    contract: 'a planned action outside allowedOperations is rejected',
    // The plan then executes an operation the workflow never permitted. This is a
    // bounded-authority bypass: the whole point of `allowedOperations` is that a
    // workflow declares what its plan may do.
    find: "    if (operation && !allowedSet.has(operation)) reasons.push('operation ' + operation + ' is not in allowedOperations');",
    replace: '    if (false) reasons.push(\'unreachable\');',
    expect: 'a planned deletePath runs despite being outside allowedOperations'
  },
  {
    name: 'child-tickets-auto-run',
    suite: 'workflow-ticket-plan-test.js',
    file: 'server.js',
    contract: 'executeTicketPlan children are created blocked and do not auto-run',
    // Spawning children unblocked lets one ticket fan out into unbounded execution
    // with no operator decision in between.
    // An earlier attempt targeted only the explanatory COMMENT above this code and
    // survived, which proves nothing about the suite — a mutation must change
    // behavior, not prose.
    find: `    objective: planTicket.objective,
    status: 'blocked',
    blockedReason: 'Created by executeTicketPlan; child workflow execution is not automatic in v1.',`,
    replace: `    objective: planTicket.objective,
    status: 'open',
    blockedReason: null,`,
    expect: 'child tickets are dispatched without an operator decision'
  },
  {
    name: 'workflow-guidance-leaks-into-ordinary-prompt',
    suite: 'workflow-prompt-composition-test.js',
    file: 'server.js',
    contract: 'workflow-draft guidance is included only when it applies to the run',
    // Drop the applicability gate so every run is taught workflow-draft rules. The
    // positive assertions all still pass — the workflow run keeps its guidance — so
    // only the negative controls catch this, which is why they are load-bearing.
    // Aimed at the applicability predicate itself, not at one guidance block: an
    // earlier attempt gated on AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED, which is off
    // by default here, so removing it changed nothing.
    find: '  const includeWorkflowDraftPromptGuidance = isWorkflowDraftPromptObjective(ticket.objective);',
    replace: '  const includeWorkflowDraftPromptGuidance = true;',
    expect: 'an ordinary run is told canonical workflow-draft rules that do not apply to it'
  },
  {
    name: 'protected-path-gate-disabled',
    suite: 'workspace-authority-gate-test.js',
    file: 'server.js',
    contract: 'a mutation targeting a protected path is refused',
    // Aimed at the shared MATCHER, not at one gate. An earlier attempt neutered
    // `blockProtectedWorkspaceOperation` alone and SURVIVED: a second, independent
    // authority check also matches protected paths, so removing one layer left the
    // contract intact. Defense in depth again — the same lesson as the A10
    // `access_users` mutation. Both gates consult this one function, so this is the
    // earliest layer that actually removes the protection.
    find: '  return readProtectedWorkspacePaths().find(pattern => workspacePatternMatches(pattern, relativePath)) || null;',
    replace: '  return null;',
    expect: 'a run writes to a protected path unopposed'
  },
  {
    name: 'prepared-prestate-not-propagated',
    suite: 'resumable-execution-test.js',
    file: 'persistence/postgres/store.js',
    contract: 'the prepared-intent projection exposes the pre-state it persisted',
    // Restores A22 exactly: drop the persisted document from the projection, so the
    // first pass reads `prepared.intent.preState` one level too shallow and builds a
    // receipt with no `before` and no `createdResources`, while recovery rebuilds it
    // from the document and the two disagree. The mutation does NOT duplicate under
    // this — the run fails on an idempotency conflict instead — so a suite that only
    // checked "no duplicate mutation" would have stayed green.
    find: `  return {
    ...document,
    id: positiveSafeInteger(row.id, 'targetOperationIntent.id'),`,
    replace: `  return {
    id: positiveSafeInteger(row.id, 'targetOperationIntent.id'),`,
    expect: 'first execution and recovery build different receipts for one operation'
  },
  {
    name: 'assignment-column-divergence',
    suite: 'assignment-audit-test.js',
    file: 'persistence/postgres/store.js',
    contract: 'reassignment writes the AUTHORITATIVE assignment columns',
    // Restores the exact A21 divergence: the assignment lands in the JSON body, where
    // ticketFromRow's column read shadows it. The endpoint still answers 200, still
    // advances the revision, and still writes an audit log and event claiming the
    // move — and the ticket does not move. Reproducing it here keeps the defect from
    // silently returning.
    find: `           SET assignment_target_type = $4,
               assignment_target_id = $5,
               body = ticket.body || $6::jsonb,`,
    replace: `           SET assignment_target_type = ticket.assignment_target_type,
               assignment_target_id = ticket.assignment_target_id,
               body = ticket.body || jsonb_build_object('assignmentTargetType', $4::text, 'assignmentTargetId', $5::bigint) || $6::jsonb,`,
    expect: 'the assignment lands only in the body, where the column shadows it'
  },
  {
    name: 'status-change-loses-from-status',
    suite: 'status-transition-evidence-test.js',
    file: 'server.js',
    contract: 'a status change records the status it came FROM',
    // Record the destination as the origin. Every surface still shows a transition,
    // the log still exists, and the trail becomes useless: "open → open" cannot tell
    // an operator what actually happened. A suite asserting only that a log EXISTS
    // would stay green through this.
    find: '    fromStatus: previousStatus,',
    replace: '    fromStatus: status,',
    expect: 'the transition log claims it came from where it went'
  },
  {
    name: 'browser-page-text-not-evidence',
    suite: 'browser-evidence-verdict-test.js',
    file: 'server.js',
    contract: 'captured page text is sufficient browser evidence on its own',
    // Aimed at the ACTIVE sufficiency boundary, one branch at a time. The run still
    // starts, still persists its browser operations, still terminalizes and still
    // writes a finalized replay — only the durable verdict is wrong, which is the
    // one thing this suite exists to notice.
    find: '  const hasContentEvidence = hasReadPageText || maxElementCount >= 3 || hasScreenshot;',
    replace: '  const hasContentEvidence = maxElementCount >= 3 || hasScreenshot;',
    expect: 'a run that read the page text is reported as having insufficient evidence'
  },
  {
    name: 'browser-dom-observation-not-evidence',
    suite: 'browser-evidence-verdict-test.js',
    file: 'server.js',
    contract: 'a DOM observation of at least three elements is sufficient browser evidence on its own',
    // The other half of the same boundary, kept separate on purpose: a suite whose
    // sufficient run captured BOTH text and a DOM inventory would stay green through
    // either branch being removed, because the surviving branch would carry it.
    find: '  const hasContentEvidence = hasReadPageText || maxElementCount >= 3 || hasScreenshot;',
    replace: '  const hasContentEvidence = hasReadPageText || hasScreenshot;',
    expect: 'a run that observed the page structure is reported as having insufficient evidence'
  },
  {
    name: 'recoverable-workspace-error-terminates-run',
    suite: 'workspace-error-containment-test.js',
    file: 'server.js',
    contract: 'an environmental workspace failure does not end the run',
    // The carve-out stops matching, so every failure is terminal. A missing file the
    // model could have worked around now kills the run — the regression the five
    // retired er* suites were written for.
    find: "          if (error.failureKind !== 'workspace_error') {",
    replace: "          if (error.failureKind !== 'no-such-failure-kind') {",
    expect: 'a readFile on a missing path fails the run instead of being reported back'
  },
  {
    name: 'policy-refusal-treated-as-recoverable',
    suite: 'workspace-error-containment-test.js',
    file: 'server.js',
    contract: 'a policy refusal ends the run rather than being handed back as feedback',
    // The other direction of the same discriminator, and the more dangerous one: a
    // refused path escape becomes ordinary feedback, the model is asked again, and a
    // containment boundary turns into a retry loop.
    find: "          if (error.failureKind !== 'workspace_error') {",
    replace: "          if (error.failureKind === 'no-such-failure-kind') {",
    expect: 'a path escaping the workspace root leaves the run alive for another turn'
  },
  {
    name: 'missing-file-classified-as-policy-refusal',
    suite: 'workspace-error-containment-test.js',
    file: 'server.js',
    contract: 'a missing file is an environmental failure, not a policy refusal',
    // Aimed one layer below the branch above: the CLASSIFIER. The discriminator is
    // untouched and still correct; it is simply told the wrong thing. The run dies and
    // the record calls a missing file "blocked", which is what an operator would read
    // as an authorization decision that never happened.
    find: "    return createStructuredWorkspaceError(error.message, 'WORKSPACE_FS_ENOENT', 'workspace_error', {",
    replace: "    return createStructuredWorkspaceError(error.message, 'WORKSPACE_FS_ENOENT', 'protected_path', {",
    expect: 'a missing file is reported as a blocked policy refusal and fails the run'
  }
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isFileClean(relativePath) {
  const result = spawnSync('git', ['diff', '--quiet', '--', relativePath], { cwd: ROOT });
  return result.status === 0;
}

const restorers = new Map();

function restoreAll() {
  for (const [absolutePath, original] of restorers) {
    try {
      fs.writeFileSync(absolutePath, original);
      if (sha256(fs.readFileSync(absolutePath)) !== sha256(original)) {
        console.error(`CRITICAL: failed to restore ${absolutePath} — restore it from git before continuing.`);
      }
    } catch (error) {
      console.error(`CRITICAL: could not restore ${absolutePath}: ${error.message}`);
    }
  }
  restorers.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { restoreAll(); process.exit(130); });
}

function runSuite(suite) {
  const result = spawnSync(process.execPath, [path.join('scripts', suite)], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
    encoding: 'utf8',
    timeout: 15 * 60 * 1000
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function main() {
  const requested = process.argv.slice(2);
  const selected = requested.length === 0
    ? MUTATIONS
    : MUTATIONS.filter(m => requested.includes(m.name) || requested.includes(m.suite));
  if (selected.length === 0) {
    console.error(`No mutation matched ${requested.join(', ')}. Known: ${MUTATIONS.map(m => m.name).join(', ')}`);
    process.exit(1);
  }

  // Refuse to touch a file that already carries uncommitted work.
  const dirty = [...new Set(selected.map(m => m.file))].filter(file => !isFileClean(file));
  if (dirty.length > 0) {
    console.error(
      'REFUSING TO RUN: these files have uncommitted changes and would be rewritten:\n' +
      dirty.map(file => `      ${file}`).join('\n') +
      '\n      Commit or stash them first. This tool edits tracked source in place.'
    );
    process.exit(1);
  }

  const survived = [];
  let killed = 0;

  console.log(`Suite mutation test — ${selected.length} mutation(s)\n`);

  try {
    for (const mutation of selected) {
      const absolutePath = path.join(ROOT, mutation.file);
      const original = fs.readFileSync(absolutePath);
      const text = original.toString('utf8');

      const occurrences = text.split(mutation.find).length - 1;
      if (occurrences !== 1) {
        console.error(
          `FAIL: mutation "${mutation.name}" expected exactly one occurrence of its anchor in ` +
          `${mutation.file}, found ${occurrences}. The runtime moved; re-aim the mutation.`
        );
        process.exit(1);
      }

      console.log(`── ${mutation.name}`);
      console.log(`   removes: ${mutation.contract}`);
      console.log(`   so that: ${mutation.expect}`);
      console.log(`   suite:   ${mutation.suite}`);

      restorers.set(absolutePath, original);
      fs.writeFileSync(absolutePath, text.replace(mutation.find, mutation.replace));

      const startedAt = Date.now();
      const { status, output } = runSuite(mutation.suite);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

      fs.writeFileSync(absolutePath, original);
      const restoredHash = sha256(fs.readFileSync(absolutePath));
      if (restoredHash !== sha256(original)) {
        console.error(`CRITICAL: ${mutation.file} did not restore cleanly. Restore it from git.`);
        process.exit(1);
      }
      restorers.delete(absolutePath);

      if (status === 0) {
        survived.push(mutation);
        console.log(`   ✗ SURVIVED (${seconds}s) — the suite passed with the contract removed.`);
        console.log(`     Last output: ${output.trim().split('\n').slice(-1)[0]}`);
      } else {
        killed += 1;
        const failureLine = output.split('\n').reverse().find(line => /FAIL|Error|✗/.test(line)) || `exit ${status}`;
        console.log(`   ✓ killed (${seconds}s) — ${failureLine.trim().slice(0, 160)}`);
      }
      console.log('');
    }
  } finally {
    restoreAll();
  }

  if (survived.length > 0) {
    console.error(`FAIL: ${survived.length}/${selected.length} mutation(s) survived — those contracts are not actually covered:`);
    for (const mutation of survived) {
      console.error(`  - ${mutation.suite} does not detect: ${mutation.contract}`);
    }
    process.exit(1);
  }

  console.log(`PASS: suite mutation test — ${killed}/${selected.length} mutations killed; every restored suite detected its regression`);
}

main();
