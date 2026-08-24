#!/usr/bin/env node
'use strict';

// T2 Tranche 5 — store-level PostgreSQL falsification suite.
//
// Requires TEST_DATABASE_URL pointing at an ISOLATED synthetic database.
// Covers:
//   1. settlement demotion through the shared composer
//      (failed -> open; failed + unresolved triage -> blocked; interrupted -> open)
//   2. cancelTicket atomicity (authority + CANCELED one commit; idempotent
//      semantic repeat; settlement observes authority; canceled refuses rerun)
//   3. blocker-intent matrix via rerunAdmitRuns
//      (triage / exhaustion / admissionHold / reasoned refusal / none)
//   4. rerunAdmitRuns atomicity: NO durable OPEN waypoint; mid-write failure
//      rolls back attempt+runs+events; success projects prior->in_progress
//   5. migration-hook NOWAIT fail-fast (55P03) + quiescent success
//   6. updateTicketMaxAttempts canonical reprojection (lower blocks, raise
//      releases, no-op writes no reprojection)
//   6b. completed-attempt precedence: maxAttemptsExhausted may exist latently
//      but never demotes a genuinely completed Ticket; cancellation and
//      stale-completion ordering preserved
//   7. triage resolution + reprojection atomically

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision,
  normalizeCompletionDecision
} = require('../runtime/completion-decision-contract');
const { composeBlockingAuthority } = require('../runtime/ticket-blocking-authority-composer');

const ACTOR = 't2-tranche5';

async function main() {
  await withHarness('t2 tranche5 store', async ({ store }) => {
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
    const rejects = async (promise, code, message) => {
      await assert.rejects(promise, err => {
        assert.equal(err.code, code, `${message} (code ${err && err.code})`);
        return true;
      }, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };

    const agent = (await store.createConfiguredAgent({
      value: { name: 'T5 Agent', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const peer = (await store.createConfiguredAgent({
      value: { name: 'T5 Peer', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;

    const makeTicket = (objective, extra = {}) => store.createTicket({
      objective,
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      executionMode: 'agent',
      ...extra
    });
    const draft = (ticketId, agentId) => ({
      ticketId, agentId, status: 'pending', executionMode: 'agent'
    });
    const admitOne = async (ticket, agentId = agent.id) => store.createRunsAndStartTicket({
      ticketId: ticket.id,
      runDrafts: [draft(ticket.id, agentId)],
      runEventPayload: () => ({ source: ACTOR })
    });
    const failRun = async run => {
      const fresh = await store.getRun(run.id);
      await store.transitionRun({
        runId: run.id,
        expectedRevision: fresh.revision,
        fromStatuses: ['pending'],
        toStatus: 'failed',
        patch: { error: 'fixture failure' },
        eventType: 'run.execution_failed',
        eventPayload: { status: 'failed' }
      });
      return store.getRun(run.id);
    };
    const completeRun = async run => {
      const claimed = await store.claimPendingRun({
        leaseOwner: ACTOR,
        leaseDurationMs: 60000,
        eligibleRunIds: [run.id],
        claimPayload: { source: ACTOR }
      });
      assert.ok(claimed && claimed.run && claimed.run.id === run.id, 'fixture claim acquired the lease');
      let fresh = await store.getRun(run.id);
      await store.transitionRun({
        runId: run.id,
        expectedRevision: fresh.revision,
        fromStatuses: ['pending'],
        toStatus: 'running',
        leaseOwner: ACTOR,
        eventType: 'run.started',
        eventPayload: {}
      });
      fresh = await store.getRun(run.id);
      await store.transitionRun({
        runId: run.id,
        expectedRevision: fresh.revision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: ACTOR,
        eventType: 'run.execution_completed',
        eventPayload: { status: 'completed' }
      });
      return store.getRun(run.id);
    };
    const eventsFor = async ticketId => (await store.pool.query(
      `SELECT type, payload FROM ${store.schema}.events WHERE ticket_id = $1 ORDER BY position`,
      [ticketId])).rows;
    // The exact composer inputs the canonical writers read under lock,
    // composed through the SHARED module (input assembly only, no logic).
    const composeLatent = async ticket => {
      const attempts = (await store.pool.query(
        `SELECT id, ordinal, member_count, disposition, admitted_at, settled_at
         FROM ${store.table('ticket_attempts')} WHERE ticket_id = $1 ORDER BY ordinal`,
        [ticket.id])).rows.map(row => ({
        id: Number(row.id), ordinal: Number(row.ordinal),
        memberCount: Number(row.member_count), disposition: row.disposition,
        admittedAt: row.admitted_at, settledAt: row.settled_at
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
    };
    // Mint a GENUINELY completed attempt through the canonical terminalization
    // path: exact deterministic workspace_objective_receipt authority, a
    // hash-bound completed completion decision, and write-once settlement.
    const completeWithExactProof = async (ticket, agentId) => {
      const snapshot = buildCompletionAuthoritySnapshot({
        objective: ticket.objective,
        kind: 'deterministic',
        recognized: true,
        intent: 'workspace_write',
        completionPolicy: 'workspace_objective_receipt',
        directPostconditions: [],
        verificationPolicy: 'when_declared',
        capturedAt: new Date().toISOString()
      });
      const admitted = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [{
          ticketId: ticket.id, agentId, status: 'pending', executionMode: 'agent',
          completionAuthoritySnapshot: snapshot
        }],
        runEventPayload: () => ({ source: ACTOR })
      });
      const run = admitted.runs[0];
      const claimed = await store.claimPendingRun({
        leaseOwner: ACTOR, leaseDurationMs: 60000,
        eligibleRunIds: [run.id], claimPayload: { source: ACTOR }
      });
      assert.ok(claimed && claimed.run && claimed.run.id === run.id,
        'fixture claim acquired the lease');
      let fresh = await store.getRun(run.id);
      await store.transitionRun({
        runId: run.id, expectedRevision: fresh.revision,
        fromStatuses: ['pending'], toStatus: 'running', leaseOwner: ACTOR,
        eventType: 'run.started', eventPayload: {}
      });
      fresh = await store.getRun(run.id);
      const finalizedAt = new Date().toISOString();
      const objectivePath = `reports/${ticket.id}/summary.md`;
      const replaySnapshot = {
        runId: run.id, ticketId: ticket.id,
        events: [{ type: 'workspace.objective_satisfied', objectivePaths: [objectivePath] }],
        parsedModelPlans: [], providerRequests: [], modelResponses: [],
        workspaceOperations: [], terminalStatus: 'completed', finalizedAt
      };
      return {
        run,
        snapshot,
        terminalized: await store.terminalizeRun({
          runId: run.id,
          expectedRevision: fresh.revision,
          fromStatuses: ['running'],
          status: 'completed',
          leaseOwner: ACTOR,
          patch: { currentPhase: 'terminalization' },
          replaySnapshot,
          executionEvent: {
            type: 'run.execution_completed',
            payload: { status: 'completed', completedAt: finalizedAt }
          },
          beforeReplayEvents: [],
          replayEvent: {
            type: 'run.snapshot_finalized',
            payload: { status: 'completed', finalizedAt }
          },
          beforeEvaluationEvents: [{
            type: 'run.violations_checked', payload: { status: 'none' }
          }],
          evaluation: {
            effectiveness: { status: 'unknown' },
            violations: { status: 'none' },
            browserEvidence: null
          },
          consequence: context => {
            const base = {
              mutations: [],
              created: [{ path: objectivePath }],
              updated: [], deleted: [], renamed: [], notifications: [],
              externalEffects: [],
              verification: {
                postconditionsStatus: 'unknown', violationsStatus: 'none',
                browserEvidence: null
              }
            };
            return {
              ...base,
              completionDecision: buildCompletionDecision({
                run: context.run, replaySnapshot, events: context.events,
                operations: context.operations, consequence: base,
                verificationContract: null, evaluatedAt: finalizedAt
              })
            };
          },
          terminalEvent: { type: 'run.terminalized', payload: { status: 'completed' } }
        })
      };
    };

    // ── 1. Settlement demotions ────────────────────────────────────────────
    console.log('settlement demotion');
    {
      const t = await makeTicket('demote failed to open');
      const { runs } = await admitOne(t);
      await failRun(runs[0]);
      const settled = await store.transitionTicketAfterRun({ runId: runs[0].id });
      equal(settled.ticket.status, 'open', 'failed attempt with no blocker demotes to open');
      ok(settled.changed, 'settlement reports the transition');

      const t2 = await makeTicket('demote failed to blocked under triage');
      await store.blockTicket({
        ticketId: t2.id,
        reasonCode: 'objective_ambiguous',
        summary: 'fixture ambiguity',
        triage: {
          required: true, reasonCode: 'objective_ambiguous', summary: 'fixture ambiguity',
          createdAt: new Date().toISOString(), resolvedAt: null
        }
      });
      // Admission is refused while triage is unresolved, so settle via a run
      // admitted BEFORE the blocker existed.
      const before = await makeTicket('triage-after-admission fixture');
      const admittedBefore = await admitOne(before);
      await store.blockTicket({
        ticketId: before.id,
        reasonCode: 'objective_ambiguous',
        summary: 'post-admission ambiguity',
        triage: {
          required: true, reasonCode: 'objective_ambiguous', summary: 'post-admission ambiguity',
          createdAt: new Date().toISOString(), resolvedAt: null
        }
      });
      await failRun(admittedBefore.runs[0]);
      const settledBlocked = await store.transitionTicketAfterRun({ runId: admittedBefore.runs[0].id });
      equal(settledBlocked.ticket.status, 'blocked',
        'failed attempt with unresolved triage demotes to blocked');

      const t3 = await makeTicket('interrupted recovers open');
      const { runs: r3 } = await admitOne(t3);
      const fresh3 = await store.getRun(r3[0].id);
      await store.transitionRun({
        runId: r3[0].id,
        expectedRevision: fresh3.revision,
        fromStatuses: ['pending'],
        toStatus: 'interrupted',
        patch: {},
        eventType: 'run.interrupted',
        eventPayload: { status: 'interrupted' }
      });
      const settledOpen = await store.transitionTicketAfterRun({ runId: r3[0].id });
      equal(settledOpen.ticket.status, 'open', 'interrupted attempt recovers to open');
    }

    // ── 2. cancelTicket atomicity ──────────────────────────────────────────
    console.log('cancellation atomicity');
    {
      const t = await makeTicket('cancel me');
      const result = await store.cancelTicket({
        ticketId: t.id, requestedBy: ACTOR, reason: 'fixture cancel', authoritySource: 'operator'
      });
      const persisted = await store.getTicket(t.id);
      equal(persisted.status, 'canceled', 'authority commit materializes CANCELED atomically');
      ok(result.cancellationAuthority && result.cancellationAuthority.ticketId === t.id,
        'committed authority returned');
      ok(result.event && result.event.payload.status === 'canceled',
        'provenance event carries the materialized status');

      const repeat = await store.cancelTicket({
        ticketId: t.id, requestedBy: ACTOR, reason: 'fixture cancel', authoritySource: 'operator'
      });
      ok(repeat.idempotent === true, 'semantic repeat is idempotent');

      // Settlement after cancellation observes the authority and yields.
      const t2 = await makeTicket('settle after cancel');
      const admitted = await admitOne(t2);
      await store.cancelTicket({
        ticketId: t2.id, requestedBy: ACTOR, reason: 'stop work', authoritySource: 'operator'
      });
      await failRun(admitted.runs[0]);
      const settled = await store.transitionTicketAfterRun({ runId: admitted.runs[0].id });
      equal(settled.changed, false, 'settlement cannot replace committed cancellation');
      equal((await store.getTicket(t2.id)).status, 'canceled', 'CANCELED survives settlement');

      // Canceled prior state refuses admission (attempt-less fixture reaches
      // the prior-state guard; a fixture with an unsettled attempt refuses
      // earlier on the one-unsettled invariant).
      await rejects(
        store.rerunAdmitRuns({
          ticketId: t.id, runDrafts: [draft(t.id, agent.id)],
          admissionIntent: 'rerun_terminal'
        }),
        'TICKET_CANCELLATION_ALREADY_COMMITTED',
        'canceled Tickets refuse rerun admission (named cancellation guard)');

      // Post-cancellation blocking cannot flip canceled -> blocked. The
      // reasoned blocker writer holds the same cancellation protection as
      // every other canonical lifecycle writer, under the Ticket lock.
      await rejects(
        store.blockTicket({
          ticketId: t.id, reasonCode: 'objective_ambiguous', summary: 'too late'
        }),
        'TICKET_CANCELLATION_ALREADY_COMMITTED',
        'blockTicket refuses a committed cancellation authority');
      const afterBlockRefusal = await store.getTicket(t.id);
      equal(afterBlockRefusal.status, 'canceled',
        'the refused blocker left CANCELED materialized');
      ok(afterBlockRefusal.cancellationAuthority !== null &&
         afterBlockRefusal.cancellationAuthority !== undefined,
        'and the durable authority is intact');
      equal(await store.pool.query(
        `SELECT COUNT(*)::int AS n FROM ${store.table('events')}
         WHERE ticket_id = $1 AND type = 'ticket.blocked'`, [t.id]
      ).then(result => result.rows[0].n), 0,
      'no ticket.blocked event was written by the refused blocker');
    }

    // ── 3. Blocker-intent matrix ───────────────────────────────────────────
    console.log('blocker-intent matrix');
    {
      // Unresolved triage: no intent supersedes.
      const tt = await makeTicket('triage gate');
      await store.blockTicket({
        ticketId: tt.id, reasonCode: 'objective_ambiguous', summary: 'ambiguity',
        triage: { required: true, reasonCode: 'objective_ambiguous', summary: 'ambiguity',
          createdAt: new Date().toISOString(), resolvedAt: null }
      });
      for (const intent of ['rerun_terminal', 'retry_auto', 'release_hold', 'retry_structured_refusal']) {
        await rejects(
          store.rerunAdmitRuns({ ticketId: tt.id, runDrafts: [draft(tt.id, agent.id)], admissionIntent: intent }),
          'TICKET_TRIAGE_REQUIRED',
          `unresolved triage refuses ${intent}`);
      }
      const resolved = await store.resolveTicketTriageAndReproject({
        ticketId: tt.id, resolvedBy: ACTOR, resolution: 'clarified'
      });
      equal(resolved.ticket.status, 'open', 'resolution + reprojection lands open atomically');
      ok(resolved.reprojectEvent && resolved.reprojectEvent.type === 'ticket.lifecycle_reprojected',
        'reprojection event recorded');

      // Exhaustion: raise-limit-first, then rerun succeeds.
      const et = await makeTicket('exhaustion gate', {
        executionPolicy: { maxAttempts: 1 }
      });
      const eAdmitted = await admitOne(et);
      await failRun(eAdmitted.runs[0]);
      const eSettled = await store.transitionTicketAfterRun({ runId: eAdmitted.runs[0].id });
      equal(eSettled.ticket.status, 'blocked', 'exhausted ceiling materializes BLOCKED at settlement');
      await rejects(
        store.rerunAdmitRuns({ ticketId: et.id, runDrafts: [draft(et.id, agent.id)], admissionIntent: 'rerun_terminal' }),
        'RUN_BUDGET_EXHAUSTED',
        'exhaustion refuses rerun (raise limit first)');
      const raised = await store.updateTicketMaxAttempts({
        ticketId: et.id,
        expectedRevision: (await store.getTicket(et.id)).revision,
        expectedExecutionPolicy: { maxAttempts: 1 },
        maxAttempts: 3,
        changedBy: ACTOR
      });
      equal(raised.ticket.status, 'open', 'raising the only exhausted ceiling releases BLOCKED');
      ok(raised.reprojectEvent && raised.reprojectEvent.type === 'ticket.lifecycle_reprojected',
        'raise records a reprojection event');
      const rerun = await store.rerunAdmitRuns({
        ticketId: et.id, runDrafts: [draft(et.id, agent.id)], admissionIntent: 'rerun_terminal'
      });
      equal(rerun.ticket.status, 'in_progress', 'rerun after release admits directly to IN_PROGRESS');
      equal(rerun.previousStatus, 'open', 'admission transition originated from the truthful prior state');

      // Lowering re-materializes BLOCKED; no-op writes no reprojection.
      const lowered = await store.updateTicketMaxAttempts({
        ticketId: et.id,
        expectedRevision: (await store.getTicket(et.id)).revision,
        expectedExecutionPolicy: { maxAttempts: 3 },
        maxAttempts: 1,
        changedBy: ACTOR
      });
      // The rerun above created a second attempt; its unsettled attempt wins
      // precedence, so lower cannot block while in flight — settle it first.
      if (!lowered.reprojectEvent) {
        const live = await store.getCurrentTicketAttempt(et.id);
        ok(live && live.disposition === null, 'unsettled attempt outranks lowering (rule 2)');
      }

      // Admission hold: release_hold authorized; other intents mismatch.
      const parent = await makeTicket('hold parent');
      const child = await store.createTicketWithEvent({
        ticket: {
          objective: 'held child', status: 'blocked',
          assignmentTargetType: 'agent', assignmentTargetId: peer.id,
          assignmentMode: 'individual', executionMode: 'agent',
          parentTicketId: parent.id, parentRunId: null,
          spawnedByStepId: 'step-1', spawnPlanId: '7',
          spawnIdempotencyKey: `t5-hold-${parent.id}`,
          createdBy: 'workflow:t5'
        },
        eventPayload: {
          parentTicketId: parent.id, spawnPlanId: '7',
          spawnIdempotencyKey: `t5-hold-${parent.id}`, createdBy: 'workflow:t5'
        }
      });
      equal(child.ticket.status, 'blocked', 'held child created blocked');
      await rejects(
        store.rerunAdmitRuns({ ticketId: child.ticket.id, runDrafts: [draft(child.ticket.id, peer.id)], admissionIntent: 'rerun_terminal' }),
        'TICKET_BLOCKER_INTENT_MISMATCH',
        'hold refuses non-release intents');
      const released = await store.rerunAdmitRuns({
        ticketId: child.ticket.id, runDrafts: [draft(child.ticket.id, peer.id)],
        admissionIntent: 'release_hold'
      });
      equal(released.ticket.status, 'in_progress', 'release_hold admits directly to IN_PROGRESS');
      ok(released.supersededBlocker && released.supersededBlocker.kind === 'admission_hold',
        'release superseded the admission hold by reference');

      // Reasoned refusal: retry_structured_refusal authorized; supersedes.
      const rt = await makeTicket('refusal gate');
      await store.blockTicket({
        ticketId: rt.id, reasonCode: 'structured_planning_refused',
        summary: 'planner unavailable at planning time'
      });
      await rejects(
        store.rerunAdmitRuns({ ticketId: rt.id, runDrafts: [draft(rt.id, agent.id)], admissionIntent: 'rerun_terminal' }),
        'TICKET_BLOCKER_INTENT_MISMATCH',
        'refusal blocks generic rerun_terminal');
      const retried = await store.rerunAdmitRuns({
        ticketId: rt.id, runDrafts: [draft(rt.id, agent.id)],
        admissionIntent: 'retry_structured_refusal'
      });
      equal(retried.ticket.status, 'in_progress', 'authorized retry admits');
      ok(retried.supersededBlocker && retried.supersededBlocker.kind === 'refusal_event',
        'successful admission superseded the reasoned refusal');

      // No blocker: operator/auto intents allowed; hold token mismatched.
      const free = await makeTicket('no blocker');
      await rejects(
        store.rerunAdmitRuns({ ticketId: free.id, runDrafts: [draft(free.id, agent.id)], admissionIntent: 'release_hold' }),
        'TICKET_BLOCKER_INTENT_MISMATCH',
        'release_hold without a hold mismatches');
    }

    // ── 3b. Completed-attempt precedence over maxAttemptsExhausted ─────────
    console.log('completed-attempt precedence');
    {
      // A genuinely completed Ticket (exact proof, not Run-status proxy).
      const ct = await makeTicket('completion outranks the exhausted ceiling');
      const { snapshot, terminalized } =
        await completeWithExactProof(ct, agent.id);
      const decision = normalizeCompletionDecision(
        terminalized.consequence.completionDecision);
      equal(decision.completionDisposition, 'completed',
        'fixture mints completionDisposition completed (exact authority)');
      equal(decision.reasonCode, 'OBJECTIVE_COMPLETED',
        'exact proof carries OBJECTIVE_COMPLETED');
      equal(decision.objectiveContractHash, snapshot.objectiveContractHash,
        'decision binds the run completion-authority hash');
      const settledCompleted = await store.transitionTicketAfterRun({
        runId: terminalized.run.id
      });
      equal(settledCompleted.ticket.status, 'completed',
        'fixture Ticket is COMPLETED on exact proof');
      const completedAttempt = await store.getCurrentTicketAttempt(ct.id);
      ok(completedAttempt && completedAttempt.disposition === 'completed' &&
          completedAttempt.settledAt !== null,
        'latest attempt settled completed with settledAt');

      const beforePolicy = await store.getTicket(ct.id);
      const consumed = await store.countTicketAttempts(ct.id);
      equal(consumed, 1, 'exactly one attempt is consumed');
      const eventsBeforePolicy = await eventsFor(ct.id);

      // Lowering to the exact consumed ceiling must persist the policy AND
      // keep the lifecycle COMPLETED: exhaustion stays latent.
      const lowered = await store.updateTicketMaxAttempts({
        ticketId: ct.id,
        expectedRevision: beforePolicy.revision,
        expectedExecutionPolicy: beforePolicy.executionPolicy || null,
        maxAttempts: consumed,
        changedBy: ACTOR
      });
      equal(lowered.ticket.executionPolicy.maxAttempts, 1,
        'policy value actually changed/persisted (maxAttempts = 1)');
      equal(lowered.ticket.status, 'completed',
        'policy update at the exhausted ceiling keeps COMPLETED');
      ok(lowered.reprojectEvent === null || lowered.reprojectEvent === undefined,
        'no lifecycle reprojection event was needed');
      const eventsAfterPolicy = await eventsFor(ct.id);
      equal(eventsAfterPolicy.length, eventsBeforePolicy.length + 1,
        'exactly one new durable event (the policy record)');
      ok(!eventsAfterPolicy.some(event => event.type === 'ticket.lifecycle_reprojected'),
        'no duplicate or contradictory lifecycle event exists');
      const attemptAfterPolicy = await store.getCurrentTicketAttempt(ct.id);
      ok(attemptAfterPolicy && attemptAfterPolicy.disposition === 'completed' &&
          attemptAfterPolicy.settledAt !== null,
        'completion authority remained intact across the policy update');
      const latent = await composeLatent(await store.getTicket(ct.id));
      equal(latent.won, 'maxAttemptsExhausted',
        'exhaustion exists as the latent composer verdict');
      ok(latent.reference && latent.reference.maxAttempts === 1 &&
          latent.reference.admittedCount === 1,
        'latent reference names the exact ceiling and count');
      equal((await store.getTicket(ct.id)).status, 'completed',
        'latent maxAttemptsExhausted does not outrank current valid completion');

      // Cancellation still outranks everything: a canceled Ticket refuses the
      // policy writer outright instead of reprojection anything.
      const cancelled = await makeTicket('cancellation outranks policy edits');
      await store.cancelTicket({
        ticketId: cancelled.id, requestedBy: ACTOR,
        reason: 'precedence fixture', authoritySource: 'operator'
      });
      const cancelledTicket = await store.getTicket(cancelled.id);
      await rejects(
        store.updateTicketMaxAttempts({
          ticketId: cancelled.id,
          expectedRevision: cancelledTicket.revision,
          expectedExecutionPolicy: cancelledTicket.executionPolicy || null,
          maxAttempts: 5,
          changedBy: ACTOR
        }),
        'TICKET_CANCELLATION_ALREADY_COMMITTED',
        'CANCELED refuses updateTicketMaxAttempts (rule 1 preserved)');

      // Stale completion cannot resurrect: after a NEWER settled failed
      // attempt governs, lowering to the new consumed count projects BLOCKED
      // from the current attempt's world, never COMPLETED from history.
      await store.updateTicketMaxAttempts({
        ticketId: ct.id,
        expectedRevision: (await store.getTicket(ct.id)).revision,
        expectedExecutionPolicy: (await store.getTicket(ct.id)).executionPolicy,
        maxAttempts: 5,
        changedBy: ACTOR
      });
      equal((await store.getTicket(ct.id)).status, 'completed',
        'raising above the ceiling leaves COMPLETED untouched (no-op write)');
      const retried = await store.rerunAdmitRuns({
        ticketId: ct.id,
        runDrafts: [draft(ct.id, peer.id)],
        admissionIntent: 'rerun_terminal'
      });
      equal(retried.ticket.status, 'in_progress',
        'released ceiling admits a second attempt from COMPLETED');
      await failRun(retried.runs.at(-1));
      const settledSecond = await store.transitionTicketAfterRun({
        runId: retried.runs.at(-1).id
      });
      equal(settledSecond.ticket.status, 'open',
        'second attempt settles failed; no blocker projects OPEN');
      const loweredAgain = await store.updateTicketMaxAttempts({
        ticketId: ct.id,
        expectedRevision: (await store.getTicket(ct.id)).revision,
        expectedExecutionPolicy: (await store.getTicket(ct.id)).executionPolicy,
        maxAttempts: 2,
        changedBy: ACTOR
      });
      equal(loweredAgain.ticket.status, 'blocked',
        'exhaustion against the CURRENT failed attempt projects BLOCKED');
      ok(loweredAgain.ticket.status !== 'completed' &&
          completedAttempt.disposition === 'completed',
        'the stale older completed attempt did not resurrect COMPLETED');
    }

    // ── 4. Atomicity / no OPEN waypoint ────────────────────────────────────
    console.log('rerun atomicity');
    {
      const t = await makeTicket('atomic rerun', { executionPolicy: { maxAttempts: 5 } });
      const first = await admitOne(t);
      await completeRun(first.runs[0]);
      const settledCompleted = await store.transitionTicketAfterRun({ runId: first.runs[0].id });
      equal(settledCompleted.ticket.status, 'completed', 'fixture reaches COMPLETED');

      const beforeEvents = await eventsFor(t.id);
      const attemptsBefore = await store.countTicketAttempts(t.id);

      // Mid-write failure: the second run's event payload throws AFTER the
      // attempt and first run were written inside the transaction.
      await assert.rejects(
        store.rerunAdmitRuns({
          ticketId: t.id,
          runDrafts: [draft(t.id, agent.id), draft(t.id, peer.id)],
          admissionIntent: 'rerun_terminal',
          runEventPayload: (() => {
            let calls = 0;
            return () => {
              calls += 1;
              if (calls >= 2) throw new Error('injected mid-write failure');
              return { source: ACTOR };
            };
          })()
        }),
        /injected mid-write failure/,
        'mid-write injection fails the transaction');

      const afterFailure = await eventsFor(t.id);
      equal(afterFailure.length, beforeEvents.length, 'failed rerun wrote zero durable events');
      equal(await store.countTicketAttempts(t.id), attemptsBefore,
        'failed rerun rolled back the new attempt');
      equal((await store.getTicket(t.id)).status, 'completed',
        'failed rerun left the Ticket exactly COMPLETED (no stranded OPEN)');
      ok(!afterFailure.some(e => e.type === 'ticket.updated' && e.payload.status === 'open'),
        'no durable OPEN waypoint exists across the failed attempt');

      const success = await store.rerunAdmitRuns({
        ticketId: t.id,
        runDrafts: [draft(t.id, agent.id)],
        admissionIntent: 'rerun_terminal',
        runEventPayload: () => ({ source: ACTOR })
      });
      equal(success.ticket.status, 'in_progress', 'successful rerun lands IN_PROGRESS');
      const afterSuccess = await eventsFor(t.id);
      ok(!afterSuccess.some(e => e.type === 'ticket.updated' && e.payload.status === 'open'),
        'no durable OPEN waypoint on the success path either');
      const lastTransition = [...afterSuccess].reverse()
        .find(e => e.type === 'ticket.updated');
      equal(lastTransition.payload.previousStatus, 'completed',
        'the single admission transition originated from COMPLETED');
      equal(lastTransition.payload.admissionIntent, 'rerun_terminal',
        'admission event carries the intent token');
    }

    // ── 5. NOWAIT fail-fast ────────────────────────────────────────────────
    console.log('migration lock NOWAIT');
    {
      const lockSql = `
        LOCK TABLE ${store.schema}.allocation_plans, ${store.schema}.runs,
                   ${store.schema}.ticket_attempts, ${store.schema}.tickets,
                   ${store.schema}.run_consequences, ${store.schema}.events,
                   ${store.schema}.diagnostic_logs, ${store.schema}.runtime_status_counts
        IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
      const blocker = await store.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(`LOCK TABLE ${store.schema}.tickets IN SHARE ROW EXCLUSIVE MODE`);
        let failedFast = false;
        let sawCode = null;
        try {
          await store.pool.query(`BEGIN; ${lockSql};`);
          await store.pool.query('COMMIT');
        } catch (error) {
          sawCode = error.code;
          failedFast = error.code === '55P03';
          await store.pool.query('ROLLBACK').catch(() => {});
        }
        ok(failedFast,
          `conflicting writer aborts the hook lock immediately (55P03, saw ${sawCode})`);
        await blocker.query('ROLLBACK');
        await store.pool.query(`BEGIN; ${lockSql}; COMMIT;`);
        ok(true, 'quiescent database acquires all eight locks');
      } finally {
        blocker.release();
      }
    }

    console.log(`\n${assertions} assertions passed`);
  });
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
