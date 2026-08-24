#!/usr/bin/env node
'use strict';

// Kernel-owned Ticket-attempt authority. This test deliberately varies Run
// topology-looking fields while asserting only immutable membership and the
// topology-neutral disposition consumed by Ticket projection.

const assert = require('node:assert/strict');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { withHarness } = require('./postgres-test-harness');

const ACTOR = 'ticket-attempt-authority-postgres-test';

async function main() {
  await withHarness('ticket attempt authority', async ({ store, schema, databaseUrl }) => {
    let assertions = 0;
    const ok = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };
    const equal = (actual, expected, message) => {
      assert.deepEqual(actual, expected, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };
    const refuses = async (operation, matcher, message) => {
      let error = null;
      try { await operation(); } catch (caught) { error = caught; }
      assert.ok(error, `${message}: expected refusal`);
      if (typeof matcher === 'function') assert.ok(matcher(error), `${message}: ${error.code || ''} ${error.message}`);
      else {
        const rendered = `${error.code || ''} ${error.message}`;
        assert.ok(matcher.test(rendered), `${message}: ${rendered}`);
      }
      assertions += 1;
      console.log(`  ok ${message}`);
      return error;
    };

    const agent = (await store.createConfiguredAgent({
      value: {
        name: 'Ticket Attempt Authority Agent', provider: 'openai',
        model: 'provider-free-fixture', apiKey: ''
      },
      changedBy: ACTOR
    })).agent;
    const secondAgent = (await store.createConfiguredAgent({
      value: {
        name: 'Ticket Attempt Authority Peer', provider: 'openai',
        model: 'provider-free-fixture', apiKey: ''
      },
      changedBy: ACTOR
    })).agent;
    const makeTicket = objective => store.createTicket({
      objective,
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      executionMode: 'agent'
    });
    const draft = (ticketId, extra = {}) => ({
      ticketId,
      agentId: agent.id,
      status: 'pending',
      executionMode: 'agent',
      ...extra
    });
    const admit = (ticket, drafts = [draft(ticket.id)]) => store.createRunsAndStartTicket({
      ticketId: ticket.id,
      runDrafts: drafts,
      runEventPayload: run => ({ source: ACTOR, runId: run.id })
    });
    const terminalize = async (run, status) => {
      let current = run;
      let leaseOwner = null;
      if (status === 'completed' && current.status === 'pending') {
        leaseOwner = `${ACTOR}-completion-${current.id}`;
        const claim = await store.claimPendingRun({
          leaseOwner, leaseDurationMs: 60_000, eligibleRunIds: [current.id]
        });
        current = (await store.startClaimedRun({
          runId: claim.run.id, leaseOwner, leaseDurationMs: 60_000
        })).run;
      }
      return (await store.transitionRun({
        runId: current.id,
        expectedRevision: current.revision,
        fromStatuses: [current.status],
        toStatus: status,
        leaseOwner,
        eventType: `run.${status}`,
        eventPayload: { source: ACTOR }
      })).run;
    };

    // Singleton and multi-member waves use the same authority and positions.
    const singletonTicket = await makeTicket('singleton attempt');
    const singleton = await admit(singletonTicket);
    equal(singleton.attempt.memberCount, 1, 'one direct Run is one singleton attempt');
    equal(singleton.runs[0].ticketAttemptId, singleton.attempt.id,
      'the store binds the Run to the kernel-minted attempt');
    equal((await store.getRunAttemptPositions({ runIds: [singleton.runs[0].id] }))[0], {
      runId: singleton.runs[0].id, attemptNumber: 1, attemptCount: 1
    }, 'attempt numbering comes from attempt ordinal, not Run count');

    const multiTicket = await makeTicket('multi member attempt');
    const multi = await admit(multiTicket, [
      draft(multiTicket.id, { assignmentMode: 'allocated' }),
      draft(multiTicket.id, {
        agentId: secondAgent.id,
        assignmentMode: 'dynamic',
        executionMode: 'workflow',
        workflowId: 'provider-free-workflow-fixture'
      })
    ]);
    equal(multi.attempt.memberCount, 2, 'one atomic multi-Run wave is one attempt with two members');
    ok(multi.runs.every(run => run.ticketAttemptId === multi.attempt.id),
      'every admitted member carries exactly the same attempt identity');
    equal(await store.countTicketAttempts(multiTicket.id), 1,
      'attempt counting does not reconstruct allocation/timestamp topology');
    equal((await store.getRunAttemptPositions({ runIds: multi.runs.map(run => run.id) })).map(item =>
      [item.attemptNumber, item.attemptCount]), [[1, 1], [1, 1]],
    'topology and execution target do not alter attempt numbering');

    // Batch admission is all-or-none even after attempt and Run INSERTs begin.
    const rollbackTicket = await makeTicket('atomic rollback attempt');
    await refuses(() => store.createRunsAndStartTicket({
      ticketId: rollbackTicket.id,
      runDrafts: [draft(rollbackTicket.id), draft(rollbackTicket.id, { agentId: secondAgent.id })],
      runEventPayload: run => {
        if (run.agentId === secondAgent.id) throw new Error('injected admission evidence failure');
        return { source: ACTOR };
      }
    }), /injected admission evidence failure/, 'failed batch evidence rolls back the whole attempt');
    equal(await store.countTicketAttempts(rollbackTicket.id), 0,
      'a failed batch leaves no attempt row');
    equal(await store.countRunsForTicket(rollbackTicket.id), 0,
      'a failed batch leaves no Run member');
    equal((await store.getTicket(rollbackTicket.id)).status, 'open',
      'a failed batch leaves the Ticket open');

    // One Ticket lock plus the database partial unique index prevents overlap.
    const raceTicket = await makeTicket('concurrent attempt admission');
    const peer = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    try {
      const race = await Promise.allSettled([
        admit(raceTicket),
        peer.createRunsAndStartTicket({
          ticketId: raceTicket.id,
          runDrafts: [draft(raceTicket.id)],
          runEventPayload: () => ({ source: `${ACTOR}-peer` })
        })
      ]);
      equal(race.filter(result => result.status === 'fulfilled').length, 1,
        'concurrent admissions produce exactly one committed attempt');
      equal(await store.countTicketAttempts(raceTicket.id), 1,
        'the Ticket has at most one unsettled attempt after the race');
      equal(await store.countRunsForTicket(raceTicket.id), 1,
        'the losing admission creates no partial Run');
      await refuses(() => store.withTransaction(async client => {
        const inserted = await client.query(
          `INSERT INTO ${store.table('ticket_attempts')} (ticket_id, ordinal, member_count)
           VALUES ($1, 2, 1) RETURNING id`,
          [raceTicket.id]
        );
        await store.createRun(draft(raceTicket.id), {
          client,
          ticketAttemptId: Number(inserted.rows[0].id)
        });
      }),
      /duplicate key|one_unsettled/i,
      'PostgreSQL independently refuses a second unsettled attempt');
    } finally {
      await peer.close();
    }

    // Identity and cardinality are neither caller-owned nor mutable.
    await refuses(() => store.createRun({
      ticketId: rollbackTicket.id,
      agentId: agent.id,
      status: 'pending',
      ticketAttemptId: singleton.attempt.id
    }), error => error.code === 'TICKET_ATTEMPT_IDENTITY_NOT_CALLER_OWNED',
    'a Run draft cannot choose an attempt identity');
    await refuses(() => store.createRun(draft(rollbackTicket.id), {
      ticketAttemptId: singleton.attempt.id
    }), /assigned only inside its admission transaction/,
    'an out-of-transaction caller cannot reuse an attempt identity');
    await refuses(() => store.pool.query(
      `UPDATE ${store.table('ticket_attempts')} SET member_count = 3, revision = revision + 1
       WHERE id = $1`, [multi.attempt.id]),
    /identity and membership cardinality are immutable/i,
    'attempt member_count is immutable');
    await refuses(() => store.pool.query(
      `UPDATE ${store.table('runs')}
       SET ticket_attempt_id = $1, revision = revision + 1 WHERE id = $2`,
      [singleton.attempt.id, multi.runs[0].id]),
    /membership|same Ticket|foreign key/i,
    'a Run cannot move between attempts');
    await refuses(() => store.withTransaction(client => store.createRun(
      draft(multiTicket.id, { agentId: secondAgent.id }),
      { client, ticketAttemptId: multi.attempt.id }
    )), /No Run may be appended/i,
    'a complete attempt cannot gain a later member');
    await refuses(() => store.withTransaction(client => store.createRun(
      draft(rollbackTicket.id),
      { client, ticketAttemptId: singleton.attempt.id }
    )), /same Ticket/i,
    'cross-Ticket attempt membership is refused');
    await refuses(() => store.withTransaction(async client => {
      await store._createTicketAttempt(client, { ticketId: rollbackTicket.id, memberCount: 2 });
    }), /membership count 0 does not equal admitted count 2/i,
    'deferred database authority refuses an underfilled membership');
    equal(await store.countTicketAttempts(rollbackTicket.id), 0,
      'the underfilled attempt transaction rolled back');

    // Settlement waits for exact membership and projects one generic result.
    const firstFailed = await terminalize(multi.runs[0], 'failed');
    const partial = await store.transitionTicketAfterRun({ runId: firstFailed.id });
    equal(partial.changed, false, 'one terminal sibling cannot settle an exact two-member attempt');
    equal((await store.getCurrentTicketAttempt(multiTicket.id)).disposition, null,
      'the incomplete attempt remains unsettled');
    await refuses(
      () => store.reopenTicket({ ticketId: multiTicket.id, rerunMode: 'retry' }),
      error => error && error.code === 'TICKET_ATTEMPT_UNSETTLED',
      'retry cannot reopen a Ticket before its exact predecessor attempt settles'
    );
    const secondInterrupted = await terminalize(multi.runs[1], 'interrupted');
    const settledMulti = await store.transitionTicketAfterRun({ runId: secondInterrupted.id });
    equal(settledMulti.attempt.disposition, 'failed',
      'existing multi-Run precedence projects failed over interrupted');
    // T2 Tranche 5: FAILED is Run/attempt authority only; with no unresolved
    // blocker the settled failed attempt demotes the Ticket to open.
    equal(settledMulti.ticket.status, 'open',
      'Ticket demotes a settled failed attempt to open (five-state)');
    await store.createRunTriage({
      runId: firstFailed.id,
      triage: {
        required: true,
        reasonCode: 'review',
        requiredDecision: 'operator_review',
        allowedActions: ['review'],
        prohibitedActions: []
      }
    });
    equal((await store.getCurrentTicketAttempt(multiTicket.id)).disposition, 'failed',
      'operator-attention evidence does not rewrite attempt disposition');
    // T2 Tranche 5: adding triage evidence AFTER settlement does not rewrite
    // history — the materialized status updates through writers, and the
    // attempt disposition itself is untouched.
    equal((await store.getTicket(multiTicket.id)).status, 'open',
      'post-settlement triage evidence does not retroactively rewrite the materialized status');
    await refuses(() => store.pool.query(
      `UPDATE ${store.table('ticket_attempts')}
       SET disposition = 'completed', settled_at = clock_timestamp(), revision = revision + 1
       WHERE id = $1`, [settledMulti.attempt.id]),
    /write-once/i,
    'attempt disposition is write-once');

    const interruptedTicket = await makeTicket('interrupted attempt');
    const interruptedAdmission = await admit(interruptedTicket);
    const interruptedRun = await terminalize(interruptedAdmission.runs[0], 'interrupted');
    const interruptedProjection = await store.transitionTicketAfterRun({ runId: interruptedRun.id });
    equal(interruptedProjection.attempt.disposition, 'interrupted',
      'interruption has an explicit attempt disposition');
    equal(interruptedProjection.ticket.status, 'open',
      'interrupted disposition returns the canonical Ticket to open');

    // Retry is a new identity; recovery/resume is the same Run and identity.
    const retryTicket = await makeTicket('retry identity');
    const retryInitial = await admit(retryTicket);
    const retryFailure = await terminalize(retryInitial.runs[0], 'failed');
    await store.transitionTicketAfterRun({ runId: retryFailure.id });
    const retried = await store.createRetryRun({
      ticketId: retryTicket.id,
      predecessorRunId: retryFailure.id,
      runDraft: draft(retryTicket.id),
      runEventPayload: () => ({ source: ACTOR })
    });
    ok(retried.attempt.id !== retryInitial.attempt.id,
      'retry mints a new attempt identity');
    equal(retried.attempt.ordinal, 2, 'retry advances the Ticket-scoped attempt ordinal');
    equal(retried.runs[0].ticketAttemptId, retried.attempt.id,
      'retry membership never reuses the predecessor attempt');
    await refuses(() => store.pool.query(
      `UPDATE ${store.table('runs')}
       SET ticket_attempt_id = $1, revision = revision + 1 WHERE id = $2`,
      [retryInitial.attempt.id, retried.runs[0].id]),
    /membership is immutable/i,
    'same-Ticket retry membership cannot be moved back to its predecessor');

    const recoveryTicket = await makeTicket('resume identity');
    const recoveryAdmission = await admit(recoveryTicket);
    const claimed = await store.claimPendingRun({
      leaseOwner: `${ACTOR}-initial`, leaseDurationMs: 60_000,
      eligibleRunIds: [recoveryAdmission.runs[0].id]
    });
    const running = await store.startClaimedRun({
      runId: claimed.run.id,
      leaseOwner: `${ACTOR}-initial`,
      leaseDurationMs: 60_000
    });
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`, [running.run.id]);
    const recoveryClaim = await store.claimRunRecovery({
      runId: running.run.id,
      recoveryOwner: `${ACTOR}-recovery`,
      leaseDurationMs: 60_000
    });
    const resumed = await store.resumeRecoveredRun({
      runId: recoveryClaim.run.id,
      recoveryOwner: `${ACTOR}-recovery`
    });
    equal(resumed.run.id, recoveryAdmission.runs[0].id,
      'recovery resumes the existing Run identity');
    equal(resumed.run.ticketAttemptId, recoveryAdmission.attempt.id,
      'recovery preserves the existing attempt identity');
    equal(await store.countTicketAttempts(recoveryTicket.id), 1,
      'recovery and resume mint no attempt');

    // Direct and Workflow targets share the same canonical projection rule.
    const workflowTicket = await makeTicket('workflow singleton attempt');
    const workflow = await admit(workflowTicket, [draft(workflowTicket.id, {
      executionMode: 'workflow', workflowId: 'workflow-fixture'
    })]);
    const completedWorkflow = await terminalize(workflow.runs[0], 'completed');
    const workflowProjection = await store.transitionTicketAfterRun({ runId: completedWorkflow.id });
    equal(workflowProjection.attempt.disposition, 'completed',
      'a Workflow Run settles through the same attempt contract');
    equal(workflowProjection.ticket.status, 'completed',
      'a Workflow target adds no Ticket lifecycle special case');

    console.log(`\nPASS: Ticket-attempt authority — ${assertions} assertions`);
  });
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
