#!/usr/bin/env node
'use strict';

// maxAttempts policy edit versus parent Ticket finalization — PostgreSQL-native.
//
// This controls the exact terminalization/projection gap that scenario 2 of
// rerun-admission-gate-test.js can observe accidentally:
//
//   1. the second Run terminalizes through the real runtime;
//   2. the existing after_run.snapshot_finalized crash seam prevents the parent
//      Ticket projection from completing;
//   3. a hermetic preload lets the policy route read that in_progress Ticket,
//      then completes transitionTicketAfterRun before the policy writer runs;
//   4. the policy edit must rebase over that status-only change without losing
//      the policy edit or rewriting either admitted Run's authority snapshots.
//
// FROZEN-T2 PARENT PROJECTION FOR THIS FIXTURE. The hermetic plan performs no
// operation and declares no postconditions, so the bare model `complete` claim
// cannot establish objective completion: each Run's persisted completion
// decision is incomplete (OBJECTIVE_INCOMPLETE). Each singleton attempt
// therefore settles FAILED and, with no canonical blocker seeded (maxAttempts
// inherits the runtime default of 3), the controlled finalization demotes the
// parent Ticket to OPEN. The policy edit then closes the ceiling at the exact
// consumed attempt count (2 of 2), so the canonical policy-writer reprojection
// composes maxAttemptsExhausted and projects BLOCKED. The race below still
// pits the policy writer against a real in_progress -> open parent
// finalization performed by the canonical settlement authority.
//
// No provider call is possible: the harness strips inherited provider credentials
// and the preload replaces global.fetch before the server starts.

const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { composeBlockingAuthority } = require('../runtime/ticket-blocking-authority-composer');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const check = createAsserter();

const BASE_POLICY = Object.freeze({
  mode: 'manual',
  maxAttempts: null,
  autoRetry: false,
  maxRuntimeMs: 987000,
  maxModelRequests: 7,
  maxWorkspaceOperations: 11,
  allowWorkspaceWrites: true,
  allowParallelRuns: true,
  allowChildTickets: true
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The exact composer inputs the canonical settlement transaction reads
// (_composeBlockingAuthorityLocked shape), composed through the SHARED
// blocking-authority module. Used to prove WHY this fixture's parent projects
// OPEN instead of asserting a lifecycle status on faith.
async function composeFor(store, ticket) {
  const attempts = (await store.pool.query(
    `SELECT id, ordinal, member_count, disposition, admitted_at, settled_at
     FROM ${store.table('ticket_attempts')} WHERE ticket_id = $1 ORDER BY ordinal`,
    [ticket.id])).rows.map(row => ({
    id: Number(row.id), ordinal: Number(row.ordinal), memberCount: Number(row.member_count),
    disposition: row.disposition, admittedAt: row.admitted_at,
    settledAt: row.settled_at === null ? null : row.settled_at
  }));
  const events = (await store.pool.query(
    `SELECT id, position, type, ts, payload FROM ${store.table('events')}
     WHERE ticket_id = $1 AND type = ANY($2::text[]) ORDER BY position`,
    [ticket.id, ['ticket.created', 'ticket.blocked', 'ticket.attempt_admitted',
      'ticket.execution_policy_updated', 'ticket.triage_resolved']])).rows.map(row => ({
    id: String(row.id), position: Number(row.position), type: row.type,
    ts: row.ts, payload: row.payload || {}
  }));
  return composeBlockingAuthority({
    triage: ticket.triage || null, attempts, events,
    executionPolicy: ticket.executionPolicy || null, closeBoundary: null
  });
}

function writeProviderPreload(directory) {
  const preload = path.join(directory, 'provider-preload.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    'global.fetch = async function () {',
    '  return {',
    '    ok: true,',
    '    status: 200,',
    "    headers: new Map([['x-request-id', 'max-attempts-finalization-race']]),",
    '    async text() {',
    '      return JSON.stringify({',
    "        output_text: JSON.stringify({ message: 'Nothing to do.', actions: [], complete: true }),",
    '        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }',
    '      });',
    '    }',
    '  };',
    '};',
    ''
  ].join('\n'));
  return preload;
}

function writeRacePreload(directory) {
  const preload = path.join(directory, 'race-preload.js');
  const storePath = path.join(ROOT, 'persistence', 'postgres', 'store.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    `const { PostgresRuntimeStore } = require(${JSON.stringify(storePath)});`,
    "const FIRED = Symbol.for('ticket-system.max-attempts-finalization-race-fired');",
    'async function finalizeParentBeforePolicyWrite(store, input) {',
    '  if (store[FIRED]) return;',
    '  store[FIRED] = true;',
    '  const page = await store.listRunsForTicket({ ticketId: input.ticketId, limit: 20 });',
    "  const terminal = page.runs.filter(run => ['completed', 'failed', 'interrupted'].includes(run.status)).at(-1);",
    "  if (!terminal) throw new Error('controlled maxAttempts race found no terminal Run');",
    "  process.stdout.write(`MAX_ATTEMPTS_RACE_FINALIZING ticket=${input.ticketId} run=${terminal.id}\\n`);",
    '  await store.transitionTicketAfterRun({ runId: terminal.id });',
    '}',
    'function wrap(methodName, applies) {',
    '  const original = PostgresRuntimeStore.prototype[methodName];',
    "  if (typeof original !== 'function') return;",
    '  PostgresRuntimeStore.prototype[methodName] = async function (input, options) {',
    '    if (process.env.TEST_CONTROL_MAX_ATTEMPTS_FINALIZATION_RACE === \'true\' && applies(input)) {',
    '      await finalizeParentBeforePolicyWrite(this, input);',
    '    }',
    '    return original.call(this, input, options);',
    '  };',
    '}',
    "wrap('transitionTicketState', input => input && input.eventType === 'ticket.execution_policy_updated');",
    "wrap('updateTicketMaxAttempts', input => input && Number.isSafeInteger(input.ticketId));",
    ''
  ].join('\n'));
  return preload;
}

function snapshotAuthorities(runs) {
  return runs.map(run => ({
    id: run.id,
    status: run.status,
    executionPolicySnapshot: run.executionPolicySnapshot,
    runtimeBudgetSnapshot: run.runtimeBudgetSnapshot
  }));
}

async function main() {
  const preloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-attempts-finalization-race-'));
  const providerPreload = writeProviderPreload(preloadDirectory);
  const racePreload = writeRacePreload(preloadDirectory);
  try {
    await withHarness('maxAttempts finalization race', async ({ store, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `MaxAttemptsRace-${STAMP}`,
          provider: 'openai',
          model: 'gpt-4.1-mini',
          apiKey: 'hermetic-test-key'
        },
        groupIds: [],
        changedBy: 'max-attempts-finalization-race-test'
      })).agent;

      const serverEnv = {
        NODE_OPTIONS: `--require ${providerPreload}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '100',
        RUN_LEASE_DURATION_MS: '600000'
      };
      const firstServer = await startServer({ env: serverEnv });
      const firstCookie = await firstServer.login();
      const objective = `MAXATTEMPTSRACE${STAMP} record the current state`;
      const created = await firstServer.request('POST', '/tickets', {
        cookie: firstCookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual',
          executionPolicy: JSON.stringify(BASE_POLICY)
        }
      });
      check(created.statusCode === 302,
        `initial Ticket creation succeeds (HTTP ${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const tickets = (await store.listTickets({ limit: 50 })).tickets || [];
        return tickets.find(candidate => candidate.objective === objective) || null;
      }, 10000, 'created Ticket');
      // Frozen-T2 truth for this fixture: the Run completes its execution loop,
      // but the bare model `complete` claim with no declared postconditions
      // mints an incomplete (OBJECTIVE_INCOMPLETE) completion decision, the
      // singleton attempt settles FAILED, and — no canonical blocker being
      // seeded — the parent Ticket demotes to OPEN. The wait still demands real
      // convergence: settlement and projection must both have landed.
      await waitFor(async () => {
        const current = await store.getTicket(ticket.id);
        const runs = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
        return current && current.status === 'open' && runs.length === 1 &&
          runs[0].status === 'completed' ? { current, runs } : null;
      }, 60000, 'first Run to complete and parent Ticket to settle OPEN');
      {
        const settled = await store.getCurrentTicketAttempt(ticket.id);
        check(settled && settled.disposition === 'failed' && settled.settledAt !== null,
          `phase-1 attempt settles FAILED (${settled && settled.disposition}, ` +
          `${settled && settled.settledAt ? 'settled' : 'unsettled'})`);
        const decisions = (await store.pool.query(
          `SELECT c.consequence->'completionDecision'->>'completionDisposition' AS disp,
                  c.consequence->'completionDecision'->>'reasonCode' AS reason
           FROM ${store.table('run_consequences')} c JOIN ${store.table('runs')} r ON r.id = c.run_id
           WHERE r.ticket_id = $1`, [ticket.id])).rows;
        check(decisions.length === 1 && decisions[0].disp === 'incomplete' &&
            decisions[0].reason === 'OBJECTIVE_INCOMPLETE',
          `the completed Run's decision is incomplete/OBJECTIVE_INCOMPLETE (${JSON.stringify(decisions)})`);
        const composedPhase1 = await composeFor(store, await store.getTicket(ticket.id));
        check(composedPhase1.won === null,
          `OPEN is canonical because this fixture seeds no canonical blocker (got ${composedPhase1.won})`);
      }
      await firstServer.stop();

      const crashingServer = await startServer({ env: {
        ...serverEnv,
        TEST_INTERRUPTION_POINT: 'after_run.snapshot_finalized'
      } });
      const crashingCookie = await crashingServer.login();
      const rerun = await crashingServer.request('POST', `/api/tickets/${ticket.id}/rerun`, {
        cookie: crashingCookie,
        body: {}
      });
      check(rerun.statusCode === 200,
        `second attempt is admitted before the controlled interruption (HTTP ${rerun.statusCode})`);

      const gap = await waitFor(async () => {
        const current = await store.getTicket(ticket.id);
        const runs = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
        if ((crashingServer.child.exitCode === null && crashingServer.child.signalCode === null) ||
            !current || current.status !== 'in_progress' ||
            runs.length !== 2 || !runs.every(run => run.status === 'completed')) return null;
        return { current, runs };
      }, 120000, 'terminal Run / unfinalized parent Ticket gap');
      check(crashingServer.child.signalCode === 'SIGKILL',
        'existing interruption seam stopped the server after Run terminalization');

      const policyBefore = structuredClone(gap.current.executionPolicy);
      const authoritiesBefore = snapshotAuthorities(gap.runs);
      check(gap.current.executionPolicy.maxAttempts === null,
        'precondition: Ticket still inherits the runtime attempt default');
      check(gap.runs.length === 2,
        'precondition: exactly two admitted attempts exist');
      check(gap.runs.every(run => run.runtimeBudgetSnapshot.maxAttempts === 3),
        'precondition: both admitted Runs retain the inherited limit of 3');

      const raceServer = await startServer({ env: {
        ...serverEnv,
        NODE_OPTIONS: `--require ${providerPreload} --require ${racePreload}`,
        TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
        TEST_CONTROL_MAX_ATTEMPTS_FINALIZATION_RACE: 'true'
      } });
      const raceCookie = await raceServer.login();
      const beforeEdit = await store.getTicket(ticket.id);
      check(beforeEdit.status === 'in_progress',
        'policy request starts while the authoritative parent projection is non-terminal');

      const edit = await raceServer.request(
        'POST',
        `/api/tickets/${ticket.id}/execution-policy/max-attempts`,
        { cookie: raceCookie, body: { maxAttempts: 2 } }
      );
      const afterEdit = await store.getTicket(ticket.id);
      const runsAfterEdit = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
      const authoritiesAfter = snapshotAuthorities(runsAfterEdit);
      const observation = {
        editHttpStatus: edit.statusCode,
        editBody: edit.body,
        ticketBefore: {
          revision: beforeEdit.revision,
          status: beforeEdit.status,
          executionPolicy: beforeEdit.executionPolicy
        },
        ticketAfter: {
          revision: afterEdit.revision,
          status: afterEdit.status,
          executionPolicy: afterEdit.executionPolicy
        },
        runCount: runsAfterEdit.length,
        existingRunSnapshotsUnchanged:
          JSON.stringify(authoritiesAfter) === JSON.stringify(authoritiesBefore),
        serverOutput: raceServer.output().slice(-3000)
      };
      console.log(`CONTROLLED_MAX_ATTEMPTS_RACE ${JSON.stringify(observation)}`);

      check(/MAX_ATTEMPTS_RACE_FINALIZING/.test(raceServer.output()),
        'controlled preload finalized the parent after the route read');
      check(edit.statusCode === 200,
        `policy-only edit rebases over Ticket finalization (HTTP ${edit.statusCode}: ${edit.body})`);
      // Frozen-T2 truth for the post-edit state, in order: (1) the controlled
      // finalizer settles attempt 2 FAILED and demotes the parent to OPEN —
      // proven by the attempt assertion below; (2) the policy writer then
      // stores maxAttempts = 2 against two consumed attempts and its canonical
      // reprojection composes maxAttemptsExhausted, projecting BLOCKED. The
      // race property under test is that neither authority was lost: the
      // finalization landed AND the policy reprojection landed on top of it.
      check(afterEdit.status === 'blocked',
        `policy reprojection projects BLOCKED at the closed ceiling (got ${afterEdit.status})`);
      {
        const settledSecond = await store.getCurrentTicketAttempt(ticket.id);
        check(settledSecond && settledSecond.disposition === 'failed' && settledSecond.settledAt !== null,
          `the controlled finalizer settled attempt 2 FAILED (${settledSecond && settledSecond.disposition}, ` +
          `${settledSecond && settledSecond.settledAt ? 'settled' : 'unsettled'})`);
      }
      // Canonical revision arithmetic: the controlled finalizer contributes one
      // transition (in_progress -> open), and the policy edit contributes two
      // (the policy persist plus the maxAttemptsExhausted reprojection to
      // blocked). Exactly these three must land — a lost or duplicated write
      // would break the count in either direction.
      check(afterEdit.revision === beforeEdit.revision + 3,
        `finalization and policy reprojection each advance the Ticket revision (${beforeEdit.revision} -> ${afterEdit.revision})`);
      check(afterEdit.executionPolicy.maxAttempts === 2,
        `stored Ticket override is 2 (${afterEdit.executionPolicy.maxAttempts})`);
      for (const [field, value] of Object.entries(policyBefore)) {
        if (field === 'maxAttempts') continue;
        check(isDeepStrictEqual(afterEdit.executionPolicy[field], value),
          `executionPolicy.${field} survives the concurrent finalization`);
      }
      check(JSON.stringify(authoritiesAfter) === JSON.stringify(authoritiesBefore),
        'both admitted Run authority snapshots remain byte-for-byte unchanged');
      check(runsAfterEdit.length === 2,
        `the policy edit creates no Run (${runsAfterEdit.length})`);

      const blocked = await raceServer.request('POST', `/api/tickets/${ticket.id}/rerun`, {
        cookie: raceCookie,
        body: {}
      });
      check(blocked.statusCode === 409,
        `next rerun is refused at the closed ceiling (HTTP ${blocked.statusCode}: ${blocked.body})`);
      check(/2 of 2/.test(JSON.parse(blocked.body).error || ''),
        `refusal names the exact attempt boundary (${blocked.body})`);
      check(await store.countRunsForTicket(ticket.id) === 2,
        `refused rerun leaves the final run count at 2 (${await store.countRunsForTicket(ticket.id)})`);

      // The rebase permission is deliberately narrow. Two policy writers that
      // started from the same policy snapshot must not both land, even though the
      // status-only finalization above was allowed to move the Ticket revision.
      const stalePolicyTicket = await store.getTicket(ticket.id);
      const competingWrites = await Promise.allSettled([3, 4].map(maxAttempts =>
        store.updateTicketMaxAttempts({
          ticketId: ticket.id,
          expectedRevision: stalePolicyTicket.revision,
          expectedExecutionPolicy: stalePolicyTicket.executionPolicy,
          maxAttempts,
          changedBy: 'max-attempts-finalization-race-test'
        })
      ));
      const fulfilled = competingWrites.filter(outcome => outcome.status === 'fulfilled');
      const rejected = competingWrites.filter(outcome => outcome.status === 'rejected');
      const conflictObservation = {
        outcomes: competingWrites.map(outcome => outcome.status === 'fulfilled'
          ? {
            status: outcome.status,
            revision: outcome.value.ticket.revision,
            maxAttempts: outcome.value.ticket.executionPolicy.maxAttempts
          }
          : {
            status: outcome.status,
            code: outcome.reason && outcome.reason.code,
            message: outcome.reason && outcome.reason.message
          })
      };
      console.log(`CONTROLLED_MAX_ATTEMPTS_POLICY_CONFLICT ${JSON.stringify(conflictObservation)}`);
      check(fulfilled.length === 1,
        `exactly one same-snapshot policy writer commits (${fulfilled.length})`);
      check(rejected.length === 1 && rejected[0].reason &&
          rejected[0].reason.code === 'OPTIMISTIC_CONCURRENCY_CONFLICT',
      `the competing policy writer is refused by optimistic authority (${JSON.stringify(conflictObservation)})`);

      const restore = await raceServer.request(
        'POST',
        `/api/tickets/${ticket.id}/execution-policy/max-attempts`,
        { cookie: raceCookie, body: { maxAttempts: 2 } }
      );
      check(restore.statusCode === 200,
        `the winning test-only policy value is restored to 2 (HTTP ${restore.statusCode})`);
      const finalTicket = await store.getTicket(ticket.id);
      const finalRuns = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
      check(finalTicket.executionPolicy.maxAttempts === 2,
        `final stored maxAttempts remains 2 (${finalTicket.executionPolicy.maxAttempts})`);
      check(JSON.stringify(snapshotAuthorities(finalRuns)) === JSON.stringify(authoritiesBefore),
        'policy conflict protection and restoration leave admitted Run snapshots unchanged');
      check(finalRuns.length === 2,
        `all policy writes leave the final Run count at 2 (${finalRuns.length})`);
    }, { schemaSlug: 'max_attempts_finalization_race' });
  } finally {
    fs.rmSync(preloadDirectory, { recursive: true, force: true });
  }

  console.log(`max-attempts-finalization-race-test: PASS (${check.count()} assertions)`);
}

main().catch(error => {
  console.error(`max-attempts-finalization-race-test: FAIL\n${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
