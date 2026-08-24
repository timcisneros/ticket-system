#!/usr/bin/env node
'use strict';

// T2 Tranche 5 — release-admission SERVER-level falsification suite.
//
// Exercises the REAL production path end-to-end:
//   POST /api/tickets/:id/release-admission
//     -> rerunTicketFromBeginning(..., 'release', ..., 'release_hold')
//     -> rerunTicketFromBeginningUnlocked -> buildManualRerunDrafts
//     -> store.rerunAdmitRuns({ admissionIntent: 'release_hold' })
//     -> composer-derived governing blocker under the frozen lock protocol
//     -> frozen intent matrix -> atomic blocked -> IN_PROGRESS admission.
//
// Falsifies:
//   A. a durable executeTicketPlan admission hold IS releasable through the
//      product surface (H1 correction: 'release_hold' is actually sent);
//   B. /rerun on a held child still refuses (other intents cannot supersede
//      an admission hold at the product layer);
//   C. release-admission CANNOT supersede unrelated blockers: a reasoned
//      refusal blocker and an unresolved-triage blocker both refuse with the
//      exact matrix codes, leaving state byte-identical;
//   D. authorization is re-derived under lock from durable authority — the
//      admitted attempt event records intent 'release_hold' AND the superseded
//      hold reference, proving the composer (not the token) authorized it.
//
// Requires TEST_DATABASE_URL pointing at an isolated synthetic database.

const { withHarness, createAsserter } = require('./postgres-test-harness');
const assert = createAsserter();

const ACTOR = 'release-admission-test';
const STAMP = Date.now();

// The race winner's execution must survive untouched: with the scheduler
// disabled, the only truthful post-race lifecycle is IN_PROGRESS over its
// pending run — never a loser-induced OPEN/BLOCKED/CANCELED demotion.
const raceFinalInvariants = status => status === 'in_progress';

const afterSnapshotUnchanged = (after, before) => after === before;

function executionPolicy() {
  return {
    mode: 'assisted', requireVerification: 'never', autoRetry: false,
    maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
    maxWorkspaceOperations: null, allowWorkspaceWrites: true,
    allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
  };
}

async function main() {
  await withHarness('t2 tranche5 release admission server', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: {
        name: `ReleaseAdmission-${STAMP}`, provider: 'ollama',
        model: 'release-admission-model', apiKey: ''
      },
      groupIds: [], changedBy: 'release-admission-test'
    })).agent;

    const now = () => new Date().toISOString();
    async function createTicket(label, extra = {}) {
      return (await store.createTicketWithEvent({
        ticket: {
          objective: `release-admission ${label} ${STAMP}`,
          acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id,
          assignmentMode: 'individual', ownedOutputPaths: null, targetRef: null,
          executionMode: 'agent', workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
          capabilityInput: null,
          executionPolicy: executionPolicy(),
          workTypeId: null, workTypeSnapshot: null,
          workContextId: null, workContextSnapshot: null,
          status: extra.status || 'open',
          createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now(),
          ...(extra.body || {})
        },
        eventPayload: extra.eventPayload || { source: 'release-admission-test' }
      })).ticket;
    }

    // Parent of the held child (any Ticket; only referential shape matters).
    const parent = await createTicket('hold-parent');

    // Held child, planted through the SAME canonical writer production uses
    // for executeTicketPlan children (server.js createChildWorkflowTicketFromPlan):
    // blocked status plus append-only spawn provenance on ticket.created.
    const spawnIdempotencyKey = `release-admission-${parent.id}-${STAMP}`;
    const heldChild = await createTicket('held-child', {
      status: 'blocked',
      body: {
        blockedReason: 'Created by executeTicketPlan; child workflow execution is not automatic in v1.',
        parentTicketId: parent.id,
        spawnedByStepId: 'step-1'
      },
      eventPayload: {
        source: 'release-admission-test',
        parentTicketId: parent.id,
        parentRunId: null,
        parentWorkflowId: 'workflow-fixture',
        spawnedByStepId: 'step-1',
        spawnPlanId: `${STAMP}:workflow-fixture:step-1:transition:0`,
        spawnIdempotencyKey,
        createdBy: 'workflow:fixture'
      }
    });
    assert(heldChild.status === 'blocked', 'held child fixture starts blocked');

    // Unrelated blocker #1: reasoned structured refusal (no triage pairing).
    const refusalBlocked = await createTicket('refusal-blocked', { status: 'open' });
    await store.blockTicket({
      ticketId: refusalBlocked.id,
      reasonCode: 'structured_planning_refused',
      summary: 'planner unavailable at planning time'
    });

    // Unrelated blocker #2: unresolved triage paired with its reason code.
    const triageBlocked = await createTicket('triage-blocked', { status: 'blocked' });
    await store.blockTicket({
      ticketId: triageBlocked.id,
      reasonCode: 'objective_ambiguous',
      summary: 'objective is ambiguous',
      triage: {
        required: true, reasonCode: 'objective_ambiguous',
        summary: 'objective is ambiguous', createdAt: now(),
        resolvedAt: null, resolvedBy: null, resolution: null
      }
    });

    // Unrelated blocker #3: exhausted attempt budget (durable policy ceiling).
    const exhausted = await createTicket('exhausted', {
      body: { executionPolicy: { maxAttempts: 1 } }
    });
    const exhaustedAttempt = await store.createRunsAndStartTicket({
      ticketId: exhausted.id,
      runDrafts: [{
        ticketId: exhausted.id, agentId: agent.id,
        status: 'pending', executionMode: 'agent'
      }],
      runEventPayload: () => ({ source: 'release-admission-test' })
    });
    const exhaustedRun = exhaustedAttempt.runs[0];
    await store.transitionRun({
      runId: exhaustedRun.id,
      expectedRevision: exhaustedRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      patch: { error: 'fixture failure' },
      eventType: 'run.execution_failed',
      eventPayload: { status: 'failed' }
    });
    await store.transitionTicketAfterRun({ runId: exhaustedRun.id });
    assert((await store.getTicket(exhausted.id)).status === 'blocked',
      'exhausted-budget fixture materializes BLOCKED via canonical reprojection');

    const server = await startServer({
      env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' }
    });
    const cookie = await server.login();

    const post = (path_, body = undefined) => server.request('POST', path_, { cookie, body });

    // Deterministic durable-state snapshot: ticket identity/status/revision,
    // every attempt row, every run row, and the full event tail after a
    // marker position. A refused request must reproduce this EXACTLY.
    const snapshot = async (ticketId, afterPosition = 0) => {
      const [ticketRow] = (await store.pool.query(
        `SELECT id, status, revision, cancellation_authority
         FROM ${store.table('tickets')} WHERE id = $1`, [ticketId])).rows;
      const attempts = await store.pool.query(
        `SELECT id, ordinal, member_count, disposition, settled_at, revision
         FROM ${store.table('ticket_attempts')} WHERE ticket_id = $1 ORDER BY ordinal`, [ticketId]);
      const runs = await store.pool.query(
        `SELECT id, status, revision FROM ${store.table('runs')} WHERE ticket_id = $1 ORDER BY id`, [ticketId]);
      const events = await store.pool.query(
        `SELECT position, type, payload FROM ${store.table('events')}
         WHERE ticket_id = $1 AND position > $2 ORDER BY position`, [ticketId, afterPosition]);
      return JSON.stringify({
        ticket: ticketRow,
        attempts: attempts.rows,
        runs: runs.rows,
        events: events.rows.map(e => ({ p: e.position, t: e.type }))
      });
    };

    // ── B. other intents cannot supersede an admission hold ────────────────
    // The generic rerun surface refuses a held child before any admission.
    const rerunHeld = await post(`/api/tickets/${heldChild.id}/rerun`);
    assert(rerunHeld.statusCode === 409,
      `rerun on held child refuses (HTTP ${rerunHeld.statusCode})`);
    assert(/admission hold/.test(JSON.parse(rerunHeld.body).error || ''),
      'the rerun refusal names the admission-hold gate');
    assert((await store.getTicket(heldChild.id)).status === 'blocked',
      'refused rerun leaves the hold governing');

    // Store-level proof that even a direct non-release intent mismatches.
    let mismatchCode = null;
    try {
      await store.rerunAdmitRuns({
        ticketId: heldChild.id,
        runDrafts: [{
          objective: heldChild.objective, agentId: agent.id,
          executionMode: 'agent', status: 'pending'
        }],
        admissionIntent: 'rerun_terminal'
      });
    } catch (error) { mismatchCode = error.code; }
    assert(mismatchCode === 'TICKET_BLOCKER_INTENT_MISMATCH',
      'rerun_terminal cannot supersede a durable admission hold');

    // ── C. release_hold cannot supersede unrelated blockers ────────────────
    const releaseRefusal = await post(`/api/tickets/${refusalBlocked.id}/release-admission`);
    assert(releaseRefusal.statusCode === 409,
      `release-admission on a refusal-blocked ticket refuses (HTTP ${releaseRefusal.statusCode})`);
    assert(JSON.parse(releaseRefusal.body).code === 'TICKET_BLOCKER_INTENT_MISMATCH',
      'the mismatch is the frozen matrix verdict');
    assert((await store.getTicket(refusalBlocked.id)).status === 'blocked',
      'failed release leaves the reasoned refusal governing');

    const releaseTriage = await post(`/api/tickets/${triageBlocked.id}/release-admission`);
    assert(releaseTriage.statusCode === 409,
      `release-admission on a triage-blocked ticket refuses (HTTP ${releaseTriage.statusCode})`);
    assert(JSON.parse(releaseTriage.body).code === 'TICKET_TRIAGE_REQUIRED',
      'triage must be resolved first, by any intent');
    assert((await store.getTicket(triageBlocked.id)).status === 'blocked',
      'failed release leaves the unresolved triage governing');

    // ── A/D. the real release path admits atomically under its own intent ──
    const released = await post(`/api/tickets/${heldChild.id}/release-admission`, {});
    assert(released.statusCode === 200,
      `release-admission succeeds for a genuinely held child (HTTP ${released.statusCode}: ` +
      `${released.body.slice(0, 200)})`);
    const releasedTicket = await store.getTicket(heldChild.id);
    assert(releasedTicket.status === 'in_progress',
      'the hold releases straight into IN_PROGRESS (no OPEN waypoint)');

    const events = (await store.listTicketEvents(heldChild.id, { limit: 100 })).events;
    const admittedEvent = events.find(event => event.type === 'ticket.attempt_admitted');
    assert(Boolean(admittedEvent), 'the release committed an attempt-admission event');
    // The intent token and superseded authority live on the canonical Ticket
    // transition event (the one carrying previousStatus/status).
    const transitionEvent = [...events].reverse()
      .find(event => event.type === 'ticket.updated' &&
        event.payload && event.payload.admissionIntent !== undefined);
    assert(Boolean(transitionEvent) &&
        transitionEvent.payload.admissionIntent === 'release_hold',
      'the admission transition carries the explicit release_hold intent');
    assert(transitionEvent && transitionEvent.payload.supersededBlocker &&
        transitionEvent.payload.supersededBlocker.kind === 'admission_hold',
      'the superseded authority is the composer-derived admission hold, proving ' +
      'authorization was re-derived under lock from durable facts');
    assert(transitionEvent && transitionEvent.payload.previousStatus === 'blocked',
      'the admission originated from the truthful BLOCKED prior state');

    // ── C. stale/raced release: loser refuses, winner intact ───────────────
    // A second held child; two releases fired CONCURRENTLY. Exactly one may
    // win the atomic admission. The loser must refuse WITHOUT interrupting,
    // settling, demoting, or adding any evidence to the winner's execution.
    const raceKey = `release-race-${parent.id}-${STAMP}`;
    const racedChild = await createTicket('raced-child', {
      status: 'blocked',
      body: {
        blockedReason: 'Created by executeTicketPlan; child workflow execution is not automatic in v1.',
        parentTicketId: parent.id,
        spawnedByStepId: 'step-1'
      },
      eventPayload: {
        source: 'release-admission-test',
        parentTicketId: parent.id,
        parentRunId: null,
        parentWorkflowId: 'workflow-fixture',
        spawnedByStepId: 'step-1',
        spawnPlanId: `${STAMP}:workflow-fixture:step-1:transition:1`,
        spawnIdempotencyKey: raceKey,
        createdBy: 'workflow:fixture'
      }
    });
    assert(racedChild.status === 'blocked', 'raced child fixture starts blocked');
    const raceMarker = Number((await store.pool.query(
      `SELECT COALESCE(MAX(position), 0) AS p FROM ${store.table('events')} WHERE ticket_id = $1`,
      [racedChild.id])).rows[0].p);
    const [raceA, raceB] = await Promise.all([
      post(`/api/tickets/${racedChild.id}/release-admission`, {}),
      post(`/api/tickets/${racedChild.id}/release-admission`, {})
    ]);
    const outcomes = [raceA, raceB];
    const winners = outcomes.filter(r => r.statusCode === 200);
    const losers = outcomes.filter(r => r.statusCode === 409);
    assert(winners.length === 1 && losers.length === 1,
      `exactly one concurrent release wins (${outcomes.map(r => r.statusCode).join(',')})`);
    assert(JSON.parse(losers[0].body).code === 'TICKET_BLOCKER_INTENT_MISMATCH' ||
           JSON.parse(losers[0].body).code === 'STATE_TRANSITION_CONFLICT' ||
           JSON.parse(losers[0].body).code === 'TICKET_RERUN_STALE_ATTEMPT',
      'the losing release refuses through blocker/intent authority');
    const racedFinal = await store.getTicket(racedChild.id);
    assert(raceFinalInvariants(racedFinal.status), `winner execution intact (${racedFinal.status})`);
    const racedAttempts = await store.listTicketAttempts({ ticketId: racedChild.id });
    assert(racedAttempts.attempts.length === 1, 'the race admitted exactly one attempt');
    const racedRuns = await store.pool.query(
      `SELECT status FROM ${store.table('runs')} WHERE ticket_id = $1`, [racedChild.id]);
    assert(racedRuns.rows.length === 1 && racedRuns.rows[0].status === 'pending',
      'the winning execution was never interrupted by the loser');

    // ── B. immediate repeat/double-click is mutation-free ──────────────────
    // The hold was structurally superseded by the first successful attempt
    // (zero-attempt rule), so a repeated release_hold is UNAUTHORIZED. The
    // refused request must not interrupt, settle, demote, or write ANY new
    // evidence: full durable snapshot before/after must be byte-identical.
    const beforeRepeat = await snapshot(heldChild.id);
    assert(JSON.parse(beforeRepeat).attempts.length === 1 &&
           JSON.parse(beforeRepeat).attempts[0].disposition === null &&
           JSON.parse(beforeRepeat).runs.every(run => run.status === 'pending'),
      'pre-repeat fixture holds one unsettled attempt and an untouched pending run');
    const repeatRelease = await post(`/api/tickets/${heldChild.id}/release-admission`, {});
    assert(repeatRelease.statusCode === 409,
      `repeat release cannot double-admit (HTTP ${repeatRelease.statusCode})`);
    assert(['TICKET_BLOCKER_INTENT_MISMATCH', 'STATE_TRANSITION_CONFLICT',
      'TICKET_RERUN_STALE_ATTEMPT', 'TICKET_ATTEMPT_UNSETTLED']
      .includes(JSON.parse(repeatRelease.body).code),
      `repeat release refuses through blocker/intent authority (got ` +
      `${JSON.parse(repeatRelease.body).code}: ${String(repeatRelease.body).slice(0, 160)})`);
    const afterRepeat = await snapshot(heldChild.id);
    assert(afterRepeat === beforeRepeat,
      'the refused repeat release mutated NOTHING: ticket/attempt/run/event ' +
      'state is byte-identical (no interruption, no settlement, no demotion)');
    assert((await store.getTicket(heldChild.id)).status === 'in_progress',
      'the Ticket remains IN_PROGRESS after the refused repeat');

    // ── D. wrong blockers refuse release_hold without mutation ─────────────
    for (const target of [
      { label: 'reasoned refusal', id: refusalBlocked.id },
      { label: 'unresolved triage', id: triageBlocked.id },
      { label: 'exhausted budget', id: exhausted.id }
    ]) {
      const before = await snapshot(target.id);
      const refused = await post(`/api/tickets/${target.id}/release-admission`, {});
      assert(refused.statusCode === 409,
        `release_hold against ${target.label} refuses (HTTP ${refused.statusCode})`);
      assert(afterSnapshotUnchanged(await snapshot(target.id), before),
        `${target.label}: refused release mutated nothing`);
    }

    // ── E. completed/canceled targets stay dominant and untouched ──────────
    const completedTicket = await createTicket('completed-target', {});
    const completedAttempt = await store.createRunsAndStartTicket({
      ticketId: completedTicket.id,
      runDrafts: [{
        ticketId: completedTicket.id, agentId: agent.id,
        status: 'pending', executionMode: 'agent'
      }],
      runEventPayload: () => ({ source: 'release-admission-test' })
    });
    const claimedRun = await store.claimPendingRun({
      leaseOwner: ACTOR, leaseDurationMs: 60000,
      eligibleRunIds: [completedAttempt.runs[0].id]
    });
    assert(Boolean(claimedRun && claimedRun.run), 'completed-target fixture claim');
    await store.startClaimedRun({
      runId: completedAttempt.runs[0].id, leaseOwner: ACTOR, leaseDurationMs: 60000 });
    let fresh = await store.getRun(completedAttempt.runs[0].id);
    await store.transitionRun({
      runId: completedAttempt.runs[0].id,
      expectedRevision: fresh.revision,
      fromStatuses: ['running'],
      toStatus: 'completed',
      leaseOwner: ACTOR,
      patch: { completedAt: now() },
      eventType: 'run.completed',
      eventPayload: { status: 'completed' }
    });
    await store.transitionTicketAfterRun({ runId: completedAttempt.runs[0].id });
    assert((await store.getTicket(completedTicket.id)).status === 'completed',
      'completed-target fixture settled COMPLETED');

    const canceledTicket = await createTicket('canceled-target', {});
    await store.cancelTicket({
      ticketId: canceledTicket.id, requestedBy: ACTOR,
      reason: 'fixture cancel', authoritySource: 'operator'
    });

    for (const target of [
      { label: 'completed', id: completedTicket.id },
      { label: 'canceled', id: canceledTicket.id }
    ]) {
      const before = await snapshot(target.id);
      const refused = await post(`/api/tickets/${target.id}/release-admission`, {});
      assert(refused.statusCode === 409,
        `release_hold against a ${target.label} Ticket refuses (HTTP ${refused.statusCode})`);
      if (target.label === 'canceled') {
        assert(JSON.parse(refused.body).code === 'TICKET_CANCELLATION_ALREADY_COMMITTED',
          'cancellation dominance names its own guard');
      } else {
        assert(JSON.parse(refused.body).code === 'TICKET_BLOCKER_INTENT_MISMATCH' ||
               JSON.parse(refused.body).code === 'STATE_TRANSITION_CONFLICT',
          'completed refusal routes through blocker/intent authority');
      }
      assert(afterSnapshotUnchanged(await snapshot(target.id), before),
        `${target.label}: refused release mutated nothing`);
      assert((await store.getTicket(target.id)).status ===
        (target.label === 'completed' ? 'completed' : 'canceled'),
        `${target.label} lifecycle survives the refused release`);
    }

    console.log(`\nPASS: T2 Tranche 5 release-admission server path — ${assert.count()} assertions`);
  }, { schemaSlug: 't2_tranche5_release_admission' });
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
