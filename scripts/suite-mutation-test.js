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
