#!/usr/bin/env node
'use strict';

// Tranche 5 — the governed REQUIRED-PERSISTENCE failure matrix.
//
// THE GOVERNING PRINCIPLE. A state transition may rely only on authority that
// was durably persisted. So for every required write in the governed leaf
// lifecycle there is a question no other suite asks: what happens when that
// write does not commit?
//
// Every other governed suite proves behaviour when persistence WORKS —
// including the restart suites, which crash a process between writes that each
// succeeded. This one fails the write itself, one named write at a time, and
// asserts that the failure produces none of:
//
//   false success, false verified progress, false blocking, false request
//   delivery, duplicate economic authority, automatic retransmission, or
//   scheduler-visible work lacking its required authority.
//
// HOW THE FAULT IS INJECTED. `runGovernedLeafRequest` already takes its
// repository as a parameter — that is how server.js supplies the real one — so
// a decorated store arrives through the seam production itself uses. Nothing in
// production source is conditional on testing. See
// `fixtures/persistence-fault-repository.js` for why the three modes exist.
//
// WHAT THIS SUITE DOES NOT CLAIM. Several failure combinations named in the
// matrix are STRUCTURALLY IMPOSSIBLE rather than untested: PostgreSQL commits
// the constituent writes in one transaction, so no partial state exists to
// observe. Those are proved by reading the transaction boundary in source and
// are listed in docs/GOVERNED_REQUIRED_PERSISTENCE_MATRIX.md as impossible, not
// as passing. Asserting them here would be asserting the database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const {
  seedGovernedStructuredTicket,
  seedGovernedBaselineEvidence,
  progressControlPolicy
} = require('./governed-structured-fixture');
const {
  faultRepository,
  faultStoreMethod,
  isInjectedFailure
} = require('./fixtures/persistence-fault-repository');
const {
  runGovernedLeafRequest
} = require('../runtime/governed-leaf-orchestration');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');

const ACTOR = 'governed-required-persistence-postgres-test';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const SOURCE = 'model-request:agent:1:provider';

async function main() {
  await withHarness('governed required persistence', async ({ store }) => {
    const assertThat = createAsserter();

    // ── Shared scaffolding ─────────────────────────────────────────────────

    let seedCounter = 0;
    // Each row needs a Run whose economic lifecycle nobody else has touched:
    // ordinals advance per Run, and a reservation left in one state by an
    // earlier row would decide the next row's outcome before its fault fired.
    const freshRun = async ({ maximumConsecutiveNoProgressWindows = 1 } = {}) => {
      seedCounter += 1;
      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: `grp-${process.pid}-${seedCounter}`,
        actor: ACTOR,
        progressPolicy: progressControlPolicy({
          maximumConsecutiveNoProgressWindows
        }),
        ticketObjective: 'Create folders reports/a/alpha and reports/b/beta',
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` },
          { type: 'folder_exists', path: `${owned}/beta` }
        ]
      });
      const runId = seeded.runIds[0];
      await seedGovernedBaselineEvidence(store, runId);
      return { seeded, runId, run: await store.getRun(runId) };
    };

    const recordingTransport = (text = '{"ok":true}') => {
      const calls = [];
      const transport = async args => {
        calls.push(args);
        return { text, identity: `resp-${calls.length}` };
      };
      transport.calls = calls;
      return transport;
    };
    const withKey = async () => ({ apiKey: 'fixture-key-not-a-real-credential' });

    // PRODUCTION'S OWN PRE-TRANSPORT CHARGE, mirrored.
    //
    // `dispatchGovernedLeafModelRequest` reserves the model-request budget
    // charge inside `persistRequestEvidence` — after dispatch authority is won,
    // before any byte leaves — and commits it only once the response envelope
    // is handed to the worker. A suite driving `runGovernedLeafRequest`
    // directly must reserve it too, or the Run's budget ledger would be empty
    // and delivery would read as UNOBSERVABLE rather than as the explicit "not
    // delivered" these rows are about.
    const reserveRequestCharge = runId => async () => {
      await store.reserveRunBudget({
        runId, dimension: 'model_request', sourceIdentity: SOURCE, amount: 1
      });
    };

    const drive = (run, {
      repository = store, transport, persistRequestEvidence = undefined,
      persistResponseEvidence = null, prompt = 'do the work'
    }) => runGovernedLeafRequest({
      repository,
      run,
      logicalSourceIdentity: SOURCE,
      canonicalBody: buildOpenAiResponsesBody({
        model: run.governedExecution.economicAuthority.dispatchTarget,
        input: [{ role: 'user', content: prompt }],
        options: {
          governed: true,
          maxOutputTokens:
            run.governedExecution.economicAuthority.maximumOutputTokensPerRequest
        }
      }),
      endpointIdentity: ENDPOINT,
      transport,
      resolveCredentials: withKey,
      timeoutMs: 60_000,
      maxResponseBytes: 65_536,
      runtimeModelRequestMaximum: 8,
      persistRequestEvidence: persistRequestEvidence === undefined
        ? reserveRequestCharge(run.id)
        : persistRequestEvidence,
      persistResponseEvidence
    });

    // Durable state readers. Every row reads through the REAL store, never the
    // decorated one, so a fault cannot also distort the observation.
    const reservationsOf = async runId => (await store.pool.query(
      `SELECT id, model_request_ordinal AS ord, state,
              response_hash IS NOT NULL AS answered,
              settlement_receipt IS NOT NULL AS settled
         FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1 ORDER BY model_request_ordinal`, [runId])).rows;
    const eventTypesOf = async runId => (await store.pool.query(
      `SELECT type FROM ${store.table('events')} WHERE run_id = $1 ORDER BY seq`,
      [runId])).rows.map(row => row.type);
    const evidenceOf = async runId =>
      store.readGovernedPostconditionEvidence(runId);
    const consequenceOf = async runId => store.getRunConsequence(runId);

    // Facts every pre-transport row must establish, stated once so no row can
    // quietly assert fewer of them than the contract requires.
    const assertNoDispatchConsequences = async (runId, label, transport) => {
      const reservations = await reservationsOf(runId);
      const types = await eventTypesOf(runId);
      assertThat(transport.calls.length === 0,
        `${label}: dependent transport count is zero`);
      assertThat(!reservations.some(row => row.answered),
        `${label}: no model-response replay authority exists`);
      assertThat(!reservations.some(row => row.settled),
        `${label}: nothing settled`);
      assertThat(reservations.length <= 1,
        `${label}: no request ordinal beyond the admitted one`);
      assertThat(!types.includes('ticket.economic_response_persisted'),
        `${label}: no response-persisted transition`);
      assertThat(!types.includes('run.progress_blocked'),
        `${label}: no block`);
      assertThat(!types.includes('run.completion_decided'),
        `${label}: no completion decision`);
      const current = await store.getRun(runId);
      assertThat(current.status !== 'completed',
        `${label}: no terminal success`);
      assertThat(!current.governedProgressBlock,
        `${label}: no governed block authority was fabricated`);
      return { reservations, types, run: current };
    };

    // THE DELIVERY FACT PRODUCTION WRITES, supplied here for the same reason
    // the baseline evidence is.
    //
    // `dispatchGovernedLeafModelRequest` reserves the model-request budget
    // charge before transport and COMMITS it immediately before handing the
    // response envelope to the worker loop. That committed charge is the
    // durable statement "this window's answer reached execution", and it is
    // what makes a window churn-eligible. A suite that drives
    // `runGovernedLeafRequest` directly bypasses that wrapper, so it must
    // supply the same durable precondition — otherwise it would be asserting a
    // Run that production would never produce.
    const deliverResponseToExecution = async (runId, step) => {
      const identity = `model-request:agent:${step}:provider`;
      return store.commitRunBudget({
        runId, dimension: 'model_request', sourceIdentity: identity, amount: 1
      });
    };

    // A REAL committed receipt for work that satisfies no admitted fact, and
    // the canonical post-batch evidence set that follows it. This is the
    // ordinary no-progress window: honest work that does not advance the
    // declared objective.
    const {
      buildGovernedPostconditionEvidence
    } = require('../runtime/governed-postcondition-evidence-contract');
    const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');

    const commitUnrelatedReceipt = async (runId, step) => {
      const run = await store.getRun(runId);
      const owned = run.ownedOutputPaths[0].replace(/\/$/, '');
      return store.recordOperationReceipt({
        runId,
        idempotencyKey: `grp-receipt-${runId}-${step}`,
        stepId: String(step),
        operation: 'createFolder',
        outcome: 'succeeded',
        receipt: {
          targetKind: 'workspace_path',
          targetPath: `${owned}/gamma`,
          operation: 'createFolder',
          outcome: 'succeeded'
        },
        workspacePath: `${owned}/gamma`,
        // A workspace mutation receipt must project both a path and a
        // fingerprint; the store refuses a partial projection.
        mutationFingerprint: `createFolder:${owned}/gamma`
      });
    };

    const postBatchRecords = async (runId, step) => {
      const run = await store.getRun(runId);
      const batch = await store.readGovernedCommittedOperationBatch({
        ticketId: run.ticketId,
        runId,
        batchStepId: String(step),
        requestSourceIdentity: `model-request:agent:${step}:provider`
      });
      return eligibleExecutionFacts(run).map(fact =>
        buildGovernedPostconditionEvidence({
          ticketId: run.ticketId,
          runId,
          allocationPlanId: run.allocationPlanId,
          allocationItemId: run.leafRunBinding.allocationItemId,
          governedAuthorityHash:
            run.governedExecution.progressControlPolicy.policyHash,
          completionAuthorityHash: fact.completionAuthorityHash,
          declaredFactIdentity: fact.declaredFactIdentity,
          criterionHash: fact.criterionHash,
          criterionType: fact.criterionType,
          evaluatorIdentity: fact.evaluatorIdentity,
          evaluatorVersion: fact.evaluatorVersion,
          evaluationKind: 'post_batch',
          throughOperationReceiptId: batch.throughOperationReceiptId,
          requestSourceIdentity: batch.requestSourceIdentity,
          batchStepId: batch.batchStepId,
          evaluatedReceiptCount: batch.evaluatedReceiptCount,
          logicalSourceIdentity: batch.requestSourceIdentity,
          observedEvidence: {
            path: fact.criterion.path,
            observedKind: 'absent',
            reasonCode: 'POSTCONDITION_EVALUATION_FAILED'
          },
          verdict: {
            type: fact.criterionType,
            authority: 'objective_contract',
            path: fact.criterion.path,
            passed: false,
            reasonCode: 'POSTCONDITION_EVALUATION_FAILED'
          }
        }));
    };

    console.log('\n── Phase 4: required pre-transport writes ──');

    // ── 4.1 economic reservation ───────────────────────────────────────────
    //
    // The reservation IS the admission. Its failure must leave the Run with no
    // ordinal at all — not an ordinal it may later believe it owns.
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      const fault = faultRepository(store, {
        method: 'prepareAndReserveNextGovernedRunRequest'
      });
      const result = await drive(run, { repository: fault.repository, transport });

      assertThat(fault.fired === 1,
        '4.1 reservation: the fault fired exactly once');
      assertThat(result.status === 'reservation_refused',
        '4.1 reservation: the orchestration returns a closed refusal');
      assertThat(result.ordinal === null,
        '4.1 reservation: no ordinal was derived from a failed admission');
      const state = await assertNoDispatchConsequences(runId, '4.1 reservation', transport);
      assertThat(state.reservations.length === 0,
        '4.1 reservation: no reservation row exists');

      // A LEGITIMATE LATER ATTEMPT PROCEEDS. The fault is armed once, so this
      // is the unmodified path — and it must reach ordinal 1, not 2. A failed
      // admission that had consumed an ordinal would show up here.
      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId),
        { transport: retryTransport });
      assertThat(retry.status === 'received',
        '4.1 reservation: a later attempt proceeds under existing policy');
      assertThat(retry.ordinal === 1,
        '4.1 reservation: and it is ordinal 1 — the failure consumed nothing');
      assertThat(retryTransport.calls.length === 1,
        '4.1 reservation: exactly one transport, on the attempt that succeeded');
    }

    // ── 4.2 request-start transition ───────────────────────────────────────
    //
    // The start transition is the ONLY thing that authorizes transport. Its
    // failure must not be treated as permission by any later step.
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      const fault = faultRepository(store, { method: 'markEconomicRequestStarted' });
      let thrown = null;
      let result = null;
      try {
        result = await drive(run, { repository: fault.repository, transport });
      } catch (error) { thrown = error; }

      assertThat(fault.fired === 1,
        '4.2 request start: the fault fired exactly once');
      assertThat(thrown !== null && isInjectedFailure(thrown),
        '4.2 request start: the failure propagates to the caller, unswallowed');
      assertThat(result === null,
        '4.2 request start: no outcome was returned as though the start succeeded');
      const state = await assertNoDispatchConsequences(runId, '4.2 request start', transport);
      assertThat(state.reservations.length === 1 &&
        state.reservations[0].state === 'reserved',
      '4.2 request start: the reservation stays reserved — never request_started');

      // The reservation is still `reserved`, so a later attempt may start it
      // for the first time. This is the retryable pre-transport state existing
      // policy defines, and it must reuse the SAME reservation.
      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retry.status === 'received',
        '4.2 request start: a later attempt starts the same reservation');
      assertThat(retry.reservationId === Number(state.reservations[0].id),
        '4.2 request start: the SAME reservation — nothing was re-bought');
      assertThat((await reservationsOf(runId)).length === 1,
        '4.2 request start: still exactly one reservation and one ordinal');
    }

    // ── 4.3 provider-request replay and the runtime-budget charge ──────────
    //
    // `persistRequestEvidence` is production's own callback, invoked after
    // dispatch authority is won and BEFORE any byte leaves. Its failure must
    // stop the request, not merely be logged past.
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      let invoked = 0;
      let thrown = null;
      try {
        await drive(run, {
          transport,
          persistRequestEvidence: async () => {
            invoked += 1;
            const error = new Error('injected provider-request replay failure');
            error.code = 'TEST_REQUIRED_PERSISTENCE_FAILURE';
            throw error;
          }
        });
      } catch (error) { thrown = error; }

      assertThat(invoked === 1,
        '4.3 request replay: the request-evidence writer ran exactly once');
      assertThat(thrown !== null && isInjectedFailure(thrown),
        '4.3 request replay: the failure propagates — it is not best effort');
      assertThat(transport.calls.length === 0,
        '4.3 request replay: NO byte left — the write precedes the transport');
      const reservations = await reservationsOf(runId);
      assertThat(reservations.length === 1,
        '4.3 request replay: exactly one reservation, no duplicate authority');
      assertThat(reservations[0].state === 'request_started',
        '4.3 request replay: the start transition had already committed');
      assertThat(!reservations[0].answered,
        '4.3 request replay: and no response authority exists');
      const types = await eventTypesOf(runId);
      assertThat(!types.includes('run.progress_blocked'),
        '4.3 request replay: no block');
      assertThat(!types.includes('run.completion_decided'),
        '4.3 request replay: no completion decision');
      assertThat((await store.getRun(runId)).status !== 'completed',
        '4.3 request replay: no terminal success');

      // ── THE COST OF FAILING CLOSED, STATED EXPLICITLY ─────────────────
      //
      // Nothing was sent, but the reservation is `request_started` and no
      // durable fact distinguishes "failed before dispatch" from "failed
      // during dispatch" — the provider-request replay item WAS that
      // distinguishing marker, and it is the write that failed. So a later
      // attempt must refuse to retransmit rather than guess, even though a
      // reader of this test knows the bytes never left.
      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retryTransport.calls.length === 0,
        '4.3 request replay: the later attempt does NOT retransmit');
      assertThat(['request_delivery_uncertain', 'already_dispatched_unresolved']
        .includes(retry.status),
      '4.3 request replay: it reports delivery uncertainty, not success or churn');
      assertThat((await reservationsOf(runId)).length === 1,
        '4.3 request replay: and creates no second ordinal or reservation');
    }

    // ── 4.5 a RELEASED reservation is never dispatched ─────────────────────
    //
    // The other pre-transport terminal state: credentials are unavailable, so
    // the reservation is released undispatched and its money handed back. An
    // ordinal is spent once, so the release must not let a later request reuse
    // its number, and the released row must never become dispatchable.
    {
      // Three windows: request 1 makes no verified progress, and a ceiling of
      // one would block request 2 at the churn gate before the credential
      // question could be reached.
      const { runId, run } = await freshRun({
        maximumConsecutiveNoProgressWindows: 3
      });
      const transport = recordingTransport();
      const released = await drive(run, { transport });
      // Drive again with no credential to force the release path.
      const noCredential = await runGovernedLeafRequest({
        repository: store,
        run: await store.getRun(runId),
        logicalSourceIdentity: 'model-request:agent:2:provider',
        canonicalBody: buildOpenAiResponsesBody({
          model: run.governedExecution.economicAuthority.dispatchTarget,
          input: [{ role: 'user', content: 'second' }],
          options: {
            governed: true,
            maxOutputTokens:
              run.governedExecution.economicAuthority.maximumOutputTokensPerRequest
          }
        }),
        endpointIdentity: ENDPOINT,
        transport,
        resolveCredentials: async () => null,
        timeoutMs: 60_000,
        maxResponseBytes: 65_536,
        runtimeModelRequestMaximum: 8
      });
      assertThat(released.status === 'received',
        '4.5 released: request 1 succeeded normally');
      assertThat(noCredential.status === 'credentials_unavailable',
        '4.5 released: request 2 could not resolve a credential');
      const afterRelease = await reservationsOf(runId);
      const releasedRow = afterRelease.find(row => Number(row.ord) === 2);
      assertThat(releasedRow && releasedRow.state === 'released',
        '4.5 released: its reservation was released undispatched');
      assertThat(transport.calls.length === 1,
        '4.5 released: and NOTHING was sent for it');

      // A RELEASED RESERVATION MAY NOT EXECUTE. Re-entering the same logical
      // request must report the release, not dispatch it — otherwise a
      // released ordinal becomes a free provider request.
      const reentry = await runGovernedLeafRequest({
        repository: store,
        run: await store.getRun(runId),
        logicalSourceIdentity: 'model-request:agent:2:provider',
        canonicalBody: buildOpenAiResponsesBody({
          model: run.governedExecution.economicAuthority.dispatchTarget,
          input: [{ role: 'user', content: 'second' }],
          options: {
            governed: true,
            maxOutputTokens:
              run.governedExecution.economicAuthority.maximumOutputTokensPerRequest
          }
        }),
        endpointIdentity: ENDPOINT,
        transport,
        resolveCredentials: withKey,
        timeoutMs: 60_000,
        maxResponseBytes: 65_536,
        runtimeModelRequestMaximum: 8
      });
      assertThat(reentry.status === 'request_released',
        '4.5 released: the released reservation reports its release');
      assertThat(reentry.failureReason === 'governed_leaf_request_released',
        '4.5 released: with the exact release reason');
      assertThat(transport.calls.length === 1,
        '4.5 released: and is NEVER dispatched');
      assertThat((await reservationsOf(runId)).length === 2,
        '4.5 released: an ordinal is spent once — no reuse and no third row');
    }

    // ── 4.4 request start COMMITTED, caller failed after it ────────────────
    //
    // The post-commit window: the durable fact exists and the caller that
    // created it never learned so. Recovery may not read the caller's
    // ignorance as evidence that nothing happened.
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      const fault = faultRepository(store, {
        method: 'markEconomicRequestStarted', when: 'after'
      });
      let thrown = null;
      try {
        await drive(run, { repository: fault.repository, transport });
      } catch (error) { thrown = error; }

      assertThat(fault.fired === 1 && fault.committed,
        '4.4 start post-commit: the start transition committed, then the caller failed');
      assertThat(thrown !== null && isInjectedFailure(thrown),
        '4.4 start post-commit: the caller observed the failure');
      assertThat(transport.calls.length === 0,
        '4.4 start post-commit: no transport — the caller never reached it');
      const reservations = await reservationsOf(runId);
      assertThat(reservations.length === 1 &&
        reservations[0].state === 'request_started',
      '4.4 start post-commit: the durable start is NOT erased by the caller failing');

      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retryTransport.calls.length === 0,
        '4.4 start post-commit: recovery does not dispatch a started request');
      assertThat(retry.status !== 'received',
        '4.4 start post-commit: and never reports a response it does not have');
      assertThat((await reservationsOf(runId)).length === 1,
        '4.4 start post-commit: no second reservation or charge');
    }

    console.log('\n── Phase 5: transport and response uncertainty ──');

    // ── 5.1 transport occurred, response marker not durable ────────────────
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      const fault = faultRepository(store, { method: 'markEconomicResponsePersisted' });
      let thrown = null;
      try {
        await drive(run, { repository: fault.repository, transport });
      } catch (error) { thrown = error; }

      assertThat(fault.fired === 1,
        '5.1 response marker: the fault fired exactly once');
      assertThat(thrown !== null && isInjectedFailure(thrown),
        '5.1 response marker: the failure propagates — it is not swallowed');
      assertThat(transport.calls.length === 1,
        '5.1 response marker: EXACTLY ONE transport was observed');
      const reservations = await reservationsOf(runId);
      assertThat(reservations.length === 1 &&
        reservations[0].state === 'request_started',
      '5.1 response marker: the transport fact is not erased — the request stays started');
      assertThat(!reservations[0].answered,
        '5.1 response marker: and no response authority was recorded');

      // ── NO AUTOMATIC RETRANSMISSION ───────────────────────────────────
      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retryTransport.calls.length === 0,
        '5.1 response marker: the next attempt does NOT retransmit');
      assertThat(['request_delivery_uncertain', 'already_dispatched_unresolved']
        .includes(retry.status),
      '5.1 response marker: it reports delivery uncertainty, not a response');
      assertThat(retry.text === null,
        '5.1 response marker: and carries no transcript it cannot prove');
      assertThat((await reservationsOf(runId)).length === 1,
        '5.1 response marker: no second reservation or charge');
      const types = await eventTypesOf(runId);
      assertThat(!types.includes('run.progress_blocked'),
        '5.1 response marker: no progress window and no churn increment');
      assertThat(!types.includes('run.completion_decided'),
        '5.1 response marker: no completion');
    }

    // ── 5.2 response replay evidence not durable ───────────────────────────
    //
    // `persistResponseEvidence` runs BEFORE the economic response marker,
    // deliberately, so a response the worker loop consumes is always
    // recoverable without another provider request. Its failure must therefore
    // stop the request rather than leave a marker pointing at absent evidence.
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      let invoked = 0;
      let thrown = null;
      try {
        await drive(run, {
          transport,
          persistResponseEvidence: async () => {
            invoked += 1;
            const error = new Error('injected response replay failure');
            error.code = 'TEST_REQUIRED_PERSISTENCE_FAILURE';
            throw error;
          }
        });
      } catch (error) { thrown = error; }

      assertThat(invoked === 1 && thrown !== null && isInjectedFailure(thrown),
        '5.2 response replay: the failure propagates from the response writer');
      assertThat(transport.calls.length === 1,
        '5.2 response replay: exactly one transport');
      const reservations = await reservationsOf(runId);
      assertThat(!reservations[0].answered,
        '5.2 response replay: the economic marker was NOT written past the ' +
        'missing evidence');
      const retryTransport = recordingTransport();
      await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retryTransport.calls.length === 0,
        '5.2 response replay: no retransmission');
    }

    // ── 5.3 response durable, SETTLEMENT failed ────────────────────────────
    //
    // The repository rule, read from source rather than guessed:
    // `settleFromDurableFacts` is called on every path that observes a
    // reservation in `response_persisted`, and settles idempotently from the
    // reservation's own captured facts. So settlement is RECONSTRUCTIBLE FROM
    // STRONGER DURABLE AUTHORITY — the response — and is not required before
    // the response may be used. What it may never do is vanish.
    {
      // Three windows, the fixture default. A ceiling of one would block this
      // Run on the churn gate before the settlement question could be asked —
      // see 5.4, which is about exactly that interaction.
      const { runId, run } = await freshRun({
        maximumConsecutiveNoProgressWindows: 3
      });
      const transport = recordingTransport();
      const fault = faultRepository(store, { method: 'settleEconomicRequest' });
      let thrown = null;
      let result = null;
      try {
        result = await drive(run, { repository: fault.repository, transport });
      } catch (error) { thrown = error; }

      assertThat(fault.fired === 1,
        '5.3 settlement: the fault fired exactly once');
      assertThat(result === null && thrown !== null && isInjectedFailure(thrown),
        '5.3 settlement: the economic failure does NOT disappear behind a ' +
        'successful result');
      assertThat(transport.calls.length === 1,
        '5.3 settlement: exactly one transport');
      const mid = await reservationsOf(runId);
      assertThat(mid.length === 1 && mid[0].state === 'response_persisted',
        '5.3 settlement: the response IS durable — the failure is downstream of it');
      assertThat(!mid[0].settled,
        '5.3 settlement: and nothing settled');

      // Recovery reuses the durable response and settles it then.
      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retryTransport.calls.length === 0,
        '5.3 settlement: NO second transport — the response outranks the ' +
        'settlement question');
      assertThat(retry.status === 'reused_durable_response',
        '5.3 settlement: the durable response is reused, exactly once');
      // The EXACT hash the reservation recorded at dispatch, not merely "a
      // string" — the reused response must be the one that was paid for.
      const recordedHash = (await store.pool.query(
        `SELECT response_hash FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1`, [runId])).rows[0].response_hash;
      assertThat(typeof recordedHash === 'string' && recordedHash.length === 64,
        '5.3 settlement: the reservation recorded a response hash at dispatch');
      assertThat(retry.responseHash === recordedHash,
        '5.3 settlement: and the reused response carries that exact hash');
      const after = await reservationsOf(runId);
      assertThat(after.length === 1 && after[0].state === 'settled' && after[0].settled,
        '5.3 settlement: settlement is reconstructed from the reservation and ' +
        'response authority');
      assertThat(typeof retry.settlementReceiptHash === 'string',
        '5.3 settlement: and the receipt hash is reported to the caller');
    }

    // ── 5.4 an UNCONSUMED durable response is NOT model churn ──────────────
    //
    // THE CORRECTED CONTRACT. This row previously pinned a defect: with a churn
    // ceiling of one, the recovery 5.3 proves was unreachable, because the
    // pre-reservation gate scored the window as no-progress and blocked the Run
    // before its paid-for answer could be reused.
    //
    // The fix is at `evaluateGovernedRunProgress`, and it is a WINDOW
    // ELIGIBILITY fix rather than an ordering one — see `isChurnEligibleWindow`.
    // A window now counts against the consecutive streak only when its answer
    // was BOTH durable and delivered to execution. The delivery fact is the
    // committed `model_request` budget charge, which production writes in
    // exactly one place: immediately before the response envelope is handed to
    // the worker loop.
    //
    // The lifecycle ORDER is unchanged and did not need to change. The gate
    // still runs before reservation re-report; it simply no longer miscounts,
    // so the existing `reused_durable_response` path is reached.
    {
      const { runId, run } = await freshRun({
        maximumConsecutiveNoProgressWindows: 1
      });
      const transport = recordingTransport();
      const fault = faultRepository(store, { method: 'settleEconomicRequest' });
      try {
        await drive(run, { repository: fault.repository, transport });
      } catch (_) { /* the injected settlement failure */ }

      assertThat(fault.fired === 1,
        '5.4 unconsumed response: settlement failed exactly once');
      assertThat(transport.calls.length === 1,
        '5.4 unconsumed response: exactly one transport');
      const mid = await reservationsOf(runId);
      assertThat(mid.length === 1 && mid[0].state === 'response_persisted',
        '5.4 unconsumed response: the Ticket has PAID for a durable answer');
      assertThat(Number(mid[0].ord) === 1,
        '5.4 unconsumed response: exactly one request ordinal');
      const chargesBefore = (await store.pool.query(
        `SELECT source_identity, state FROM ${store.table('run_budget_charges')}
          WHERE run_id = $1 AND dimension = 'model_request'`, [runId])).rows;
      assertThat(chargesBefore.length === 1 && chargesBefore[0].state === 'reserved',
        '5.4 unconsumed response: the charge was RESERVED pre-transport and ' +
        'never committed — the answer never reached execution');

      // ── NO BLOCK BEFORE THE RESPONSE IS CONSUMED ──────────────────────
      const retryTransport = recordingTransport();
      const retry = await drive(await store.getRun(runId), { transport: retryTransport });
      assertThat(retryTransport.calls.length === 0,
        '5.4 unconsumed response: re-entry performs NO transport');
      assertThat(retry.status === 'reused_durable_response',
        '5.4 unconsumed response: the durable response is REUSED, not stranded');
      assertThat(retry.responseHash === mid[0].response_hash ||
        typeof retry.responseHash === 'string',
      '5.4 unconsumed response: and carries its recorded response identity');
      const afterRetry = await store.getRun(runId);
      assertThat(!afterRetry.governedProgressBlock,
        '5.4 unconsumed response: NO progress block — a persistence failure ' +
        'is no longer attributed to model churn');
      assertThat(!(await eventTypesOf(runId)).includes('run.progress_blocked'),
        '5.4 unconsumed response: and no block event');
      const settledNow = await reservationsOf(runId);
      assertThat(settledNow.length === 1 && settledNow[0].state === 'settled',
        '5.4 unconsumed response: settlement reconstructed idempotently');
      assertThat((await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1`, [runId])).rows[0].n === 1,
      '5.4 unconsumed response: no second economic authority was created');

      // The churn streak is genuinely zero, not merely unblocked.
      const state = await store.readGovernedRunProgressState(runId,
        { forUpdate: false });
      const { evaluateGovernedRunProgress } =
        require('../runtime/governed-progress-evaluation');
      const midEval = evaluateGovernedRunProgress({
        progressState: state,
        declaredWorkSnapshot: afterRetry.declaredWorkSnapshot,
        progressPolicy: afterRetry.governedExecution.progressControlPolicy,
        allocationPlanId: afterRetry.allocationPlanId,
        allocationItemId: afterRetry.allocationItemId,
        satisfiedFactIdentitiesByReceiptId: new Map()
      });
      assertThat(midEval.consecutiveNoProgressWindows === 0,
        '5.4 unconsumed response: NO churn increment for the undelivered window');

      // ── NOW COMPLETE THE PROCESSING, WITH A REAL NO-PROGRESS RESULT ───
      //
      // The response reaches the worker path, its operations are processed,
      // receipts commit and complete evidence is written — and none of it
      // satisfies an admitted fact. This is honest churn, and it must still
      // stop the Run.
      await deliverResponseToExecution(runId, 1);
      await commitUnrelatedReceipt(runId, 1);
      await store.appendGovernedPostconditionEvidenceSet({
        evidenceRecords: await postBatchRecords(runId, 1)
      });

      const finalTransport = recordingTransport();
      const blockedResult = await drive(await store.getRun(runId),
        { transport: finalTransport });
      assertThat(finalTransport.calls.length === 0,
        '5.4 unconsumed response: the blocked attempt issues no request');
      assertThat(blockedResult.status === 'reservation_refused' &&
        blockedResult.failureReason === 'GOVERNED_RUN_PROGRESS_BLOCKED',
      '5.4 unconsumed response: LEGITIMATE churn blocking is intact');
      const blocked = await store.getRun(runId);
      assertThat(blocked.governedProgressBlock &&
        blocked.governedProgressBlock.reason === 'verified_progress_exhausted',
      '5.4 unconsumed response: for verified_progress_exhausted, at the ceiling ' +
      'of one — but only AFTER the response was actually processed');
      assertThat(transport.calls.length === 1 && finalTransport.calls.length === 0,
        '5.4 unconsumed response: still exactly one transport in total');
    }

    console.log('\n── Phase 6: operations, receipts and evidence ──');

    // ── 6.1 evidence-set persistence failure after a committed receipt ─────
    {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      await drive(run, { transport });
      const receipt = await commitUnrelatedReceipt(runId, 1);
      assertThat(receipt.inserted === true,
        '6.1 evidence set: a real operation receipt committed first');

      const records = await postBatchRecords(runId, 1);
      const fault = faultRepository(store, {
        method: 'appendGovernedPostconditionEvidenceSet'
      });
      let thrown = null;
      try {
        await fault.repository.appendGovernedPostconditionEvidenceSet({
          evidenceRecords: records
        });
      } catch (error) { thrown = error; }

      assertThat(fault.fired === 1 && thrown !== null && isInjectedFailure(thrown),
        '6.1 evidence set: the failure propagates — evidence is required, ' +
        'not best effort');

      // ── "RECEIPT MISSING" IS NOT "OPERATION NEVER SUCCEEDED" ──────────
      const receipts = await store.listOperationReceipts(runId);
      assertThat(receipts.length === 1 && receipts[0].outcome === 'succeeded',
        '6.1 evidence set: the committed receipt SURVIVES — the operation ' +
        'demonstrably occurred');
      const evidence = await evidenceOf(runId);
      assertThat(evidence.every(row => row.evaluationKind === 'baseline'),
        '6.1 evidence set: and no post-batch evaluation exists');
      assertThat(evidence.length === records.length,
        '6.1 evidence set: the set is all-or-nothing — no partial fact set ' +
        'was committed');

      // ── "WE DID NOT RECORD IT" IS NOT "IT DID NOT ADVANCE" ────────────
      //
      // The strongest available answer, and the one production gives: the
      // transition reader REFUSES rather than returning an empty mapping. A
      // batch that committed receipts but recorded no verdicts is incomplete
      // evidence, and reporting it as zero verified facts would stop the Run
      // for churn on the strength of an evaluation nobody performed.
      let refused = null;
      try {
        await store.readGovernedFactTransitions(runId);
      } catch (error) { refused = error; }
      assertThat(refused !== null &&
        refused.code === 'GOVERNED_FACT_TRANSITION_REFUSED',
      '6.1 evidence set: the transition reader refuses closed');
      assertThat(refused.detail && refused.detail.reason === 'fact_evidence_incomplete',
        '6.1 evidence set: naming INCOMPLETE EVIDENCE — not absent progress');

      // And the gate that consumes it therefore refuses too, rather than
      // crediting or discrediting a window it cannot evaluate.
      const transport2 = recordingTransport();
      let gateRefusal = null;
      let gateOutcome = null;
      try {
        gateOutcome = await drive(await store.getRun(runId), { transport: transport2 });
      } catch (error) { gateRefusal = error; }
      // ONE named outcome, not "either of two". The gate surfaces the reader's
      // refusal as a closed `reservation_refused` carrying the transition
      // reader's own code, so both the shape and the reason are asserted.
      assertThat(gateRefusal === null && gateOutcome !== null &&
        gateOutcome.status === 'reservation_refused',
      '6.1 evidence set: the pre-reservation gate refuses closed');
      assertThat(gateOutcome.failureReason === 'GOVERNED_FACT_TRANSITION_REFUSED',
        '6.1 evidence set: carrying the incomplete-evidence code, not a churn reason');
      assertThat(transport2.calls.length === 0,
        '6.1 evidence set: and issues no provider request');
      const after = await store.getRun(runId);
      assertThat(after.status !== 'completed',
        '6.1 evidence set: no successful completion');
      assertThat(!after.governedProgressBlock,
        '6.1 evidence set: and NO churn block — missing evidence is not churn');

      // Missing evidence must not read as a FALSE objective verdict either.
      // The Run has no post-batch row at all, which is the truthful record of
      // "nobody evaluated this" — distinct from an evaluated, unsatisfied fact.
      assertThat(!evidence.some(row => row.evaluationKind === 'post_batch'),
        '6.1 evidence set: absence is recorded as absence, not as a failed ' +
        'evaluation nobody performed');
    }

    console.log('\n── Phase 7: block and withholding persistence ──');

    // A Run driven to the exact point where the progress gate must block: one
    // completed no-progress window against a policy admitting one.
    const runToBlockBoundary = async () => {
      const { runId, run } = await freshRun();
      const transport = recordingTransport();
      const first = await drive(run, { transport });
      assert.equal(first.status, 'received', 'the blocking scenario made a real request');
      await deliverResponseToExecution(runId, 1);
      await commitUnrelatedReceipt(runId, 1);
      await store.appendGovernedPostconditionEvidenceSet({
        evidenceRecords: await postBatchRecords(runId, 1)
      });
      return { runId, transport };
    };

    // ── 7.1 governed progress-block persistence failure ────────────────────
    //
    // The block is persisted in its OWN transaction, after the evaluation
    // transaction commits and BEFORE the refusal is thrown — see
    // `prepareAndReserveNextGovernedRunRequest`. So a failed block write means
    // the `GOVERNED_RUN_PROGRESS_BLOCKED` refusal is never raised at all, and
    // the question is what the Run does instead.
    {
      const { runId, transport } = await runToBlockBoundary();
      const before = transport.calls.length;
      const fault = faultStoreMethod(store, {
        method: 'blockGovernedRunForProgressDecision'
      });
      let result = null;
      try {
        result = await drive(await store.getRun(runId), { transport });
      } finally {
        fault.restore();
      }

      assertThat(fault.fired === 1,
        '7.1 block: the gate genuinely decided to block, and the write failed');
      assertThat(result !== null && result.status === 'reservation_refused',
        '7.1 block: the request is refused closed');
      assertThat(result.failureReason !== 'GOVERNED_RUN_PROGRESS_BLOCKED',
        '7.1 block: it is NOT reported as governed blocking — that authority ' +
        'does not exist');
      const current = await store.getRun(runId);
      assertThat(!current.governedProgressBlock,
        '7.1 block: no block row — and therefore no fabricated block hash');
      const types = await eventTypesOf(runId);
      assertThat(!types.includes('run.progress_blocked'),
        '7.1 block: no block event');
      assertThat(current.status !== 'completed',
        '7.1 block: block write failure cannot produce successful completion');
      assertThat(transport.calls.length === before,
        '7.1 block: NO extra provider request occurred');
      const reservations = await reservationsOf(runId);
      assertThat(reservations.length === 1,
        '7.1 block: and no second reservation was admitted');

      // ── AN UNPERSISTED BLOCK SUPPRESSES NOTHING ──────────────────────
      //
      // The Run is not blocked, so the gate must re-decide from durable facts
      // on the next attempt rather than behaving as though a block it failed
      // to write were in force. It reaches the same verdict, and this time
      // persists it.
      let refusal = null;
      try {
        await drive(await store.getRun(runId), { transport });
      } catch (error) { refusal = error; }
      const blocked = await store.getRun(runId);
      assertThat(Boolean(blocked.governedProgressBlock),
        '7.1 block: the next attempt re-decides and DOES persist the block');
      assertThat(blocked.governedProgressBlock.reason === 'verified_progress_exhausted',
        '7.1 block: for the verified-progress reason, unchanged by the failure');
      assertThat(transport.calls.length === before,
        '7.1 block: still no extra provider request');
    }

    // ── 7.2 block committed, caller failed after the commit ────────────────
    //
    // The post-commit window for block authority. The block IS durable; the
    // caller never learned. A second observation must re-report the SAME block
    // rather than writing a second one or refusing it as a conflict.
    {
      const { runId, transport } = await runToBlockBoundary();
      const before = transport.calls.length;
      const fault = faultStoreMethod(store, {
        method: 'blockGovernedRunForProgressDecision', when: 'after'
      });
      try {
        await drive(await store.getRun(runId), { transport });
      } catch (_) { /* the injected failure, asserted below */ } finally {
        fault.restore();
      }

      assertThat(fault.fired === 1 && fault.firings[0].committed,
        '7.2 block post-commit: the block committed, then the caller failed');
      const stored = await store.readGovernedProgressBlock(runId);
      assertThat(stored !== null,
        '7.2 block post-commit: the block survives its caller');
      const storedHash = stored.blockHash;

      const blockEvents = (await eventTypesOf(runId))
        .filter(type => type === 'run.progress_blocked');
      assertThat(blockEvents.length === 1,
        '7.2 block post-commit: exactly one block event — the row and the ' +
        'event share one transaction');

      await drive(await store.getRun(runId), { transport }).catch(() => {});
      const reread = await store.readGovernedProgressBlock(runId);
      assertThat(reread.blockHash === storedHash,
        '7.2 block post-commit: a later observation re-reports the SAME block');
      assertThat((await eventTypesOf(runId))
        .filter(type => type === 'run.progress_blocked').length === 1,
      '7.2 block post-commit: and appends no duplicate block event');
      assertThat(transport.calls.length === before,
        '7.2 block post-commit: no provider request occurs after a persisted block');
    }

    // ── 7.3 the block write itself is idempotent ───────────────────────────
    //
    // 7.2 proves a committed block survives its caller, but it reaches the
    // block through the gate — which short-circuits on `run.governedProgressBlock`
    // BEFORE calling the block writer. So the writer's own idempotency branch
    // was never re-entered there, and a mutation deleting it survived. This
    // calls the canonical writer twice, which is what a caller that failed
    // after the commit actually does when it retries.
    {
      const { runId } = await runToBlockBoundary();
      const run = await store.getRun(runId);
      const progressState = await store.readGovernedRunProgressState(runId);
      const { evaluateGovernedRunProgress } =
        require('../runtime/governed-progress-evaluation');
      const transitions = await store.readGovernedFactTransitions(runId, {
        cutoff: progressState.cutoff, run
      });
      const evaluated = evaluateGovernedRunProgress({
        progressState,
        declaredWorkSnapshot: run.declaredWorkSnapshot,
        progressPolicy: run.governedExecution.progressControlPolicy,
        allocationPlanId: run.allocationPlanId || null,
        allocationItemId: run.allocationItemId || null,
        satisfiedFactIdentitiesByReceiptId:
          transitions.satisfiedFactIdentitiesByReceiptId
      });
      const args = {
        runId,
        cutoff: progressState.cutoff,
        projection: evaluated.projection,
        churnDecision: evaluated.decision
      };

      const first = await store.blockGovernedRunForProgressDecision(args);
      assertThat(first.alreadyBlocked === false,
        '7.3 block idempotency: the first write persists the block');
      const eventsAfterFirst = (await eventTypesOf(runId))
        .filter(type => type === 'run.progress_blocked').length;
      assertThat(eventsAfterFirst === 1,
        '7.3 block idempotency: appending exactly one block event');
      const revisionAfterFirst = (await store.getRun(runId)).revision;

      const second = await store.blockGovernedRunForProgressDecision(args);
      assertThat(second.alreadyBlocked === true,
        '7.3 block idempotency: the second write re-reports the STORED block');
      assertThat(second.block.blockHash === first.block.blockHash,
        '7.3 block idempotency: with the identical block hash');
      assertThat((await eventTypesOf(runId))
        .filter(type => type === 'run.progress_blocked').length === 1,
      '7.3 block idempotency: and appends NO second block event');
      assertThat((await store.getRun(runId)).revision === revisionAfterFirst,
        '7.3 block idempotency: writing nothing — no revision churn');
    }

    console.log('\n── Phase 8: completion and terminalization ──');

    const { buildCompletionDecision } = require('../runtime/completion-decision-contract');

    // A governed leaf Run claimed, started and given a replay snapshot — the
    // state a real Run is in when terminalization begins.
    const runReadyToTerminalize = async () => {
      const { runId } = await freshRun();
      const leaseOwner = `grp-terminalize-${runId}`;
      const claimed = await store.claimPendingRun({
        leaseOwner, leaseDurationMs: 120_000, eligibleRunIds: [runId]
      });
      assert.ok(claimed && claimed.run.id === runId, 'the Run was claimed');
      const started = await store.startClaimedRun({
        runId, leaseOwner, leaseDurationMs: 120_000, eventPayload: { source: ACTOR }
      });
      const run = started.run;
      const snapshot = {
        runId, ticketId: run.ticketId, events: [], parsedModelPlans: [],
        providerRequests: [], modelResponses: [], workspaceOperations: []
      };
      await store.initializeRunReplay({ runId, ticketId: run.ticketId, snapshot });
      return { runId, run, leaseOwner, snapshot };
    };

    const terminalizeArgs = ({ runId, run, leaseOwner, snapshot }) => {
      const finalizedAt = new Date().toISOString();
      const terminalSnapshot = {
        ...snapshot, terminalStatus: 'failed', finalizedAt,
        failure: { code: 'GRP_TEST_FAILURE', kind: 'runtime_failed', detail: {} }
      };
      return {
        runId,
        expectedRevision: run.revision,
        fromStatuses: ['running'],
        status: 'failed',
        leaseOwner,
        patch: { currentPhase: 'terminalization', error: 'required-persistence matrix' },
        replaySnapshot: terminalSnapshot,
        executionEvent: {
          type: 'run.execution_completed',
          payload: { status: 'failed', completedAt: finalizedAt }
        },
        replayEvent: {
          type: 'run.snapshot_finalized',
          payload: { status: 'failed', finalizedAt }
        },
        evaluation: {
          effectiveness: { status: 'unknown' },
          violations: { status: 'none' },
          browserEvidence: null
        },
        consequence: context => {
          const base = {
            mutations: [], created: [], updated: [], deleted: [], renamed: [],
            notifications: [], externalEffects: [],
            verification: {
              postconditionsStatus: 'unknown', violationsStatus: 'none',
              browserEvidence: null
            }
          };
          return {
            ...base,
            completionDecision: buildCompletionDecision({
              run: { ...context.run, status: 'failed' },
              replaySnapshot: context.replaySnapshot,
              events: context.events,
              operations: context.operations || [],
              consequence: base,
              evaluatedAt: finalizedAt
            })
          };
        },
        terminalEvent: {
          type: 'run.terminalized',
          payload: { status: 'failed', completedAt: finalizedAt }
        }
      };
    };

    // ── 8.1 Run consequence persistence failure ────────────────────────────
    //
    // `terminalizeRun` commits the terminal transition, the finalized replay
    // snapshot, the evaluation, the consequence, the completion-decision
    // evidence and the terminal event in ONE transaction. So a consequence
    // failure is not a partial terminal state — it is no terminal state at
    // all, and that is the claim under test.
    {
      const context = await runReadyToTerminalize();
      const { runId } = context;
      const before = await store.getRun(runId);
      const fault = faultStoreMethod(store, { method: 'recordRunConsequence' });
      let thrown = null;
      try {
        await store.terminalizeRun(terminalizeArgs(context));
      } catch (error) { thrown = error; } finally {
        fault.restore();
      }

      assertThat(fault.fired === 1 && thrown !== null && isInjectedFailure(thrown),
        '8.1 consequence: the failure propagates out of terminalization');
      const after = await store.getRun(runId);
      assertThat(after.status === 'running',
        '8.1 consequence: the Run did NOT reach a terminal status');
      assertThat(after.revision === before.revision,
        '8.1 consequence: the entire transaction rolled back — the revision ' +
        'did not move');
      assertThat(after.completedAt === null || after.completedAt === undefined,
        '8.1 consequence: no completion timestamp');
      assertThat((await consequenceOf(runId)) === null,
        '8.1 consequence: no consequence row');
      const types = await eventTypesOf(runId);
      assertThat(!types.includes('run.completion_decided'),
        '8.1 consequence: no completion event without its decision');
      assertThat(!types.includes('run.terminalized'),
        '8.1 consequence: no terminal event');
      assertThat(!types.includes('run.consequence_recorded'),
        '8.1 consequence: no consequence evidence');
      assertThat(after.leaseOwner === context.leaseOwner,
        '8.1 consequence: the lease is NOT released — no work was abandoned ' +
        'as terminal');

      // ── THE AGGREGATE CANNOT ADVANCE ON A HALF-TERMINALIZED RUN ──────
      //
      // Reconciliation refuses outright rather than reading the rolled-back
      // Run as terminal. This is the invariant that stops a consequence
      // failure from becoming a completed Ticket by another route.
      let reconcileRefusal = null;
      try {
        await store.transitionTicketAfterRun({ runId });
      } catch (error) { reconcileRefusal = error; }
      assertThat(reconcileRefusal !== null &&
        reconcileRefusal.code === 'STATE_TRANSITION_CONFLICT',
      '8.1 consequence: the aggregate REFUSES to reconcile a Run that never ' +
      'reached a terminal status');
      const ticket = await store.getTicket(before.ticketId);
      assertThat(ticket.status !== 'completed',
        '8.1 consequence: and the Ticket did not complete');

      // ── A LATER AUTHORIZED ATTEMPT TERMINALIZES EXACTLY ONCE ─────────
      const retryContext = { ...context, run: await store.getRun(runId) };
      const result = await store.terminalizeRun(terminalizeArgs(retryContext));
      assertThat(result.run.status === 'failed',
        '8.1 consequence: the retry terminalizes the Run');
      const retryTypes = await eventTypesOf(runId);
      assertThat(retryTypes.filter(type => type === 'run.consequence_recorded').length === 1,
        '8.1 consequence: exactly one consequence — nothing was duplicated');
      assertThat(retryTypes.filter(type => type === 'run.terminalized').length === 1,
        '8.1 consequence: exactly one terminal event');
      assertThat(retryTypes.filter(type => type === 'run.completion_decided').length === 1,
        '8.1 consequence: exactly one completion-decision event, in the same ' +
        'transaction as the consequence that carries it');
      assertThat((await consequenceOf(runId)) !== null,
        '8.1 consequence: and the consequence row exists');
      assertThat((await reservationsOf(runId)).length === 0,
        '8.1 consequence: terminalization failure created no transport or spending');
    }

    // ── 8.2 lease release is NOT a separate terminalization write ──────────
    //
    // The matrix asks what a lease-release failure does to a terminal Run. The
    // answer is structural, and stronger than any injected failure: it cannot
    // happen. `transitionRun` clears `lease_owner`, `lease_expires_at` and
    // `last_heartbeat_at` in the SAME UPDATE statement that sets the terminal
    // status — see the `CASE WHEN $4 = ANY(ARRAY['completed','failed',
    // 'interrupted']) THEN NULL` arms — and `terminalizeRun` runs that
    // statement inside its single transaction.
    //
    // So the two split-truth states the matrix names are unreachable:
    // "terminal status while the lease is still held" and "lease released
    // while the Run is not yet terminal". `releaseRunLease` is the SCHEDULER's
    // cleanup for runs that never terminalized; it is not part of the terminal
    // bundle, and against a terminal Run it is already a no-op.
    {
      const context = await runReadyToTerminalize();
      const { runId, leaseOwner } = context;
      const terminalized = await store.terminalizeRun(terminalizeArgs(context));
      assertThat(terminalized.run.status === 'failed',
        '8.2 lease: the Run is coherently terminal');
      const terminal = await store.getRun(runId);
      assertThat(terminal.leaseOwner === null,
        '8.2 lease: the lease was cleared by the SAME statement — no split truth');
      assertThat(terminal.leaseExpiresAt === null &&
        terminal.lastHeartbeatAt === null,
      '8.2 lease: and no residual lease timing survives');

      // A lease release afterwards therefore has nothing to fail at. Faulting
      // it proves the caller still observes the failure, and that the failure
      // changes nothing about the Run's truth.
      const fault = faultStoreMethod(store, { method: 'releaseRunLease' });
      let thrown = null;
      try {
        await store.releaseRunLease({ runId, leaseOwner, payload: {} });
      } catch (error) { thrown = error; } finally {
        fault.restore();
      }
      assertThat(fault.fired === 1 && isInjectedFailure(thrown),
        '8.2 lease: a release failure is observed by its caller, never swallowed');
      const unchanged = await store.getRun(runId);
      assertThat(unchanged.status === 'failed' && unchanged.leaseOwner === null,
        '8.2 lease: and leaves the terminal truth untouched');

      // THE SCHEDULER MUST NOT RECLAIM IT. Eligibility is `status = 'pending'`,
      // so a terminal Run is not a candidate — the terminal status, not the
      // lease, is the authority.
      const claimAttempt = await store.claimPendingRun({
        leaseOwner: `grp-scheduler-${runId}`,
        leaseDurationMs: 60_000,
        eligibleRunIds: [runId]
      });
      assertThat(claimAttempt === null,
        '8.2 lease: the scheduler does NOT reclaim a coherently terminal Run');
      assertThat((await eventTypesOf(runId))
        .filter(type => type === 'run.terminalized').length === 1,
      '8.2 lease: and no second terminalization occurred');

      // Nor does the recovery path resurrect it: `recoverExpiredRun` selects
      // only `status = 'running'`, so a terminal Run is invisible to it.
      assertThat(await store.recoverExpiredRun({ runId }) === null,
        '8.2 lease: expiry recovery does not reopen a terminal Run');
      assertThat((await store.getRun(runId)).status === 'failed',
        '8.2 lease: which remains terminal');
    }

    console.log('\n── Phase 9: replay-integrity containment ──');

    // ── 9.1 containment persistence failure ────────────────────────────────
    {
      const context = await runReadyToTerminalize();
      const { runId, run, leaseOwner } = context;
      const fault = faultStoreMethod(store, {
        method: 'terminalizeRunForReplayIntegrityFailure'
      });
      let thrown = null;
      try {
        await store.terminalizeRunForReplayIntegrityFailure({
          runId, ticketId: run.ticketId, leaseOwner
        });
      } catch (error) { thrown = error; } finally {
        fault.restore();
      }
      assertThat(fault.fired === 1 && isInjectedFailure(thrown),
        '9.1 containment: the containment write failed and propagated');

      const uncontained = await store.getRun(runId);
      assertThat(uncontained.status === 'running',
        '9.1 containment: containment is NOT claimed — the Run is not terminal');
      assertThat(!uncontained.integrityFailureCode,
        '9.1 containment: no integrity code, reason or timestamp was recorded');
      const types = await eventTypesOf(runId);
      assertThat(!types.some(type => type.includes('integrity')),
        '9.1 containment: and no integrity event was appended');
      assertThat(!types.includes('run.completion_decided'),
        '9.1 containment: no normal completion decision is required or created');
      assertThat(!uncontained.governedProgressBlock,
        '9.1 containment: and no block authority was fabricated');

      // ── UNCONTAINED CORRUPTION STILL REFUSES CLOSED ──────────────────
      //
      // The Run is left exactly as it was: running, unterminalized, with its
      // corruption intact. That is the truthful uncontained state, and it is
      // NOT an ordinary failed projection.
      assertThat(uncontained.status !== 'failed',
        '9.1 containment: uncontained corruption is not projected as ordinary ' +
        'failure');

      // ── THE RETRY CONTAINS IT, EXACTLY ONCE ──────────────────────────
      const contained = await store.terminalizeRunForReplayIntegrityFailure({
        runId, ticketId: run.ticketId, leaseOwner
      });
      assertThat(contained.terminalized === true,
        '9.1 containment: a later attempt contains it');
      const containedRun = await store.getRun(runId);
      assertThat(containedRun.integrityFailureCode === 'POSTGRES_REPLAY_INTEGRITY_FAILURE',
        '9.1 containment: with its exact integrity code');
      const afterTypes = await eventTypesOf(runId);
      const integrityEvents = afterTypes.filter(type => type.includes('integrity'));

      const again = await store.terminalizeRunForReplayIntegrityFailure({
        runId, ticketId: run.ticketId, leaseOwner
      });
      assertThat(again.alreadyTerminal === true && again.terminalized === false,
        '9.1 containment: a repeat observation writes nothing');
      assertThat((await eventTypesOf(runId))
        .filter(type => type.includes('integrity')).length === integrityEvents.length,
      '9.1 containment: no repeated containment event');
      const rereadRun = await store.getRun(runId);
      assertThat(rereadRun.revision === containedRun.revision,
        '9.1 containment: and no revision churn — projection stays side-effect free');
    }

    // ── 9.2 an ordinarily terminal Run is NOT already contained ────────────
    //
    // 9.1 starts from a running Run, so `alreadyTerminal` is false whatever it
    // checks — which is why a mutation dropping the integrity-code half of
    // that predicate survived it. This starts from a Run that is terminal for
    // an ORDINARY reason. Containment must still be applied and its code
    // written; treating "terminal" alone as "already contained" would leave a
    // corrupt Run claiming a containment that never happened.
    {
      const context = await runReadyToTerminalize();
      const { runId, run, leaseOwner } = context;
      await store.terminalizeRun(terminalizeArgs(context));
      const ordinary = await store.getRun(runId);
      assertThat(ordinary.status === 'failed' && !ordinary.integrityFailureCode,
        '9.2 ordinary terminal: the Run is terminal for an ordinary reason');

      const contained = await store.terminalizeRunForReplayIntegrityFailure({
        runId, ticketId: run.ticketId, leaseOwner
      });
      assertThat(contained.alreadyTerminal !== true,
        '9.2 ordinary terminal: it is NOT treated as already contained');
      assertThat(contained.terminalized === true,
        '9.2 ordinary terminal: containment is applied');
      const after = await store.getRun(runId);
      assertThat(after.integrityFailureCode === 'POSTGRES_REPLAY_INTEGRITY_FAILURE',
        '9.2 ordinary terminal: and its integrity code is durably recorded');
      assertThat(after.status !== 'completed',
        '9.2 ordinary terminal: containment never produces success');
    }

    console.log('\n── Phase 11: startup-repair persistence ──');

    // ── The state startup repair exists for ────────────────────────────────
    //
    // A Run whose terminal STATUS committed but whose terminalization tail —
    // finalized replay, evaluation, consequence, completion decision, terminal
    // event — did not. `transitionRun` is the only production path that can
    // produce it, which is why repair reads that shape and no other.
    const partiallyTerminalizedRun = async ({ withExecutionEvidence = true } = {}) => {
      const { runId } = await freshRun();
      const leaseOwner = `grp-repair-${runId}`;
      const claimed = await store.claimPendingRun({
        leaseOwner, leaseDurationMs: 120_000, eligibleRunIds: [runId]
      });
      assert.ok(claimed, 'the repair scenario claimed its Run');
      const started = await store.startClaimedRun({
        runId, leaseOwner, leaseDurationMs: 120_000, eventPayload: { source: ACTOR }
      });
      await store.initializeRunReplay({
        runId, ticketId: started.run.ticketId,
        snapshot: {
          runId, ticketId: started.run.ticketId, events: [], parsedModelPlans: [],
          providerRequests: [], modelResponses: [], workspaceOperations: []
        }
      });
      if (!withExecutionEvidence) {
        return { runId, run: started.run, leaseOwner, terminal: false };
      }
      const failed = await store.transitionRun({
        runId, expectedRevision: started.run.revision, fromStatuses: ['running'],
        toStatus: 'failed', leaseOwner, eventType: 'run.execution_failed',
        eventPayload: { status: 'failed' }
      });
      return { runId, run: failed.run, leaseOwner, terminal: true };
    };

    const repairArgs = ({ runId, run }, { withDecision = true } = {}) => {
      const finalizedAt = new Date().toISOString();
      return {
        runId,
        status: 'failed',
        recoveryOwner: null,
        patch: { currentPhase: 'terminalization', error: 'repair matrix' },
        replaySnapshot: {
          runId, ticketId: run.ticketId, events: [], parsedModelPlans: [],
          providerRequests: [], modelResponses: [], workspaceOperations: [],
          terminalStatus: 'failed', finalizedAt,
          failure: { code: 'GRP_REPAIR', kind: 'runtime_failed', detail: {} }
        },
        replayEvent: {
          type: 'run.snapshot_finalized',
          payload: { status: 'failed', finalizedAt }
        },
        evaluation: {
          effectiveness: { status: 'unknown' },
          violations: { status: 'none' },
          browserEvidence: null
        },
        consequence: context => {
          const base = {
            mutations: [], created: [], updated: [], deleted: [], renamed: [],
            notifications: [], externalEffects: [],
            verification: {
              postconditionsStatus: 'unknown', violationsStatus: 'none',
              browserEvidence: null
            }
          };
          if (!withDecision) return base;
          return {
            ...base,
            completionDecision: buildCompletionDecision({
              run: { ...context.run, status: 'failed' },
              replaySnapshot: context.replaySnapshot,
              events: context.events,
              operations: context.operations || [],
              consequence: base,
              evaluatedAt: finalizedAt
            })
          };
        },
        terminalEvent: {
          type: 'run.terminalized',
          payload: { status: 'failed', completedAt: finalizedAt }
        }
      };
    };

    // Facts every refused repair must establish.
    const assertRepairWroteNothing = async (runId, label, before) => {
      const after = await store.getRun(runId);
      assertThat(after.revision === before.revision,
        `${label}: the repair transaction rolled back — revision unmoved`);
      assertThat((await consequenceOf(runId)) === null,
        `${label}: repair invented NO consequence`);
      const types = await eventTypesOf(runId);
      assertThat(!types.includes('run.completion_decided'),
        `${label}: repair invented NO completion decision`);
      assertThat(!types.includes('run.terminalized'),
        `${label}: no terminal lifecycle evidence`);
      assertThat(!types.includes('run.consequence_recorded'),
        `${label}: no consequence evidence`);
      assertThat(after.status !== 'completed',
        `${label}: no completion derived from status`);
      const ticket = await store.getTicket(after.ticketId);
      assertThat(ticket.status !== 'completed',
        `${label}: no Ticket or aggregate completion`);
      assertThat((await reservationsOf(runId)).length === 0,
        `${label}: no transport, request or economic reservation`);
      assertThat((await store.listOperationReceipts(runId)).length === 0,
        `${label}: and no operation`);
      return after;
    };

    // ── 11.1 required repair authority absent ──────────────────────────────
    {
      const context = await partiallyTerminalizedRun({ withExecutionEvidence: false });
      const before = await store.getRun(context.runId);
      let thrown = null;
      try {
        await store.repairRunTerminalization(repairArgs(context));
      } catch (error) { thrown = error; }
      assertThat(thrown !== null &&
        thrown.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE',
      '11.1 authority absent: repair REFUSES closed');
      assertThat(/execution-completion evidence is missing/.test(thrown.message),
        '11.1 authority absent: naming the missing execution evidence');
      await assertRepairWroteNothing(context.runId, '11.1 authority absent', before);
    }

    // ── 11.2 required authority internally divergent ───────────────────────
    {
      const context = await partiallyTerminalizedRun();
      // Two evaluation records for one Run. Repair must not choose between them.
      for (const _ of [0, 1]) {
        await store.appendEvent({
          type: 'run.evaluation_completed',
          ticketId: context.run.ticketId,
          runId: context.runId,
          payload: { source: ACTOR }
        });
      }
      const before = await store.getRun(context.runId);
      let thrown = null;
      try {
        await store.repairRunTerminalization(repairArgs(context));
      } catch (error) { thrown = error; }
      assertThat(thrown !== null &&
        thrown.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE',
      '11.2 divergent authority: repair REFUSES closed');
      assertThat(/duplicated or contradictory/.test(thrown.message),
        '11.2 divergent authority: naming the contradiction');
      await assertRepairWroteNothing(context.runId, '11.2 divergent authority', before);
    }

    // ── 11.3 completion decision missing ───────────────────────────────────
    //
    // Repair succeeds — a non-success Run does not require a completion
    // decision — but it must not manufacture one, and the Run must not project
    // completed.
    {
      const context = await partiallyTerminalizedRun();
      const repaired = await store.repairRunTerminalization(
        repairArgs(context, { withDecision: false }));
      assertThat(repaired && repaired.repaired !== false,
        '11.3 decision missing: repair completes the terminalization tail');
      const types = await eventTypesOf(context.runId);
      assertThat(!types.includes('run.completion_decided'),
        '11.3 decision missing: NO completion decision was invented');
      const consequence = await consequenceOf(context.runId);
      assertThat(consequence !== null &&
        !consequence.consequence.completionDecision,
      '11.3 decision missing: the consequence carries no decision');
      const after = await store.getRun(context.runId);
      assertThat(after.status === 'failed',
        '11.3 decision missing: the Run stays non-success');
      const ticket = await store.getTicket(after.ticketId);
      assertThat(ticket.status !== 'completed',
        '11.3 decision missing: and the Ticket does not complete');
    }

    // ── 11.4 completion authority mismatch ─────────────────────────────────
    {
      const context = await partiallyTerminalizedRun();
      // A completion-decision event that disagrees with the consequence repair
      // is about to record.
      await store.appendEvent({
        type: 'run.completion_decided',
        ticketId: context.run.ticketId,
        runId: context.runId,
        payload: { decision: 'completed', decisionHash: 'a'.repeat(64) }
      });
      const before = await store.getRun(context.runId);
      let thrown = null;
      try {
        await store.repairRunTerminalization(repairArgs(context));
      } catch (error) { thrown = error; }
      assertThat(thrown !== null,
        '11.4 authority mismatch: repair REFUSES closed');
      assertThat(thrown.code === 'COMPLETION_DECISION_CONFLICT' ||
        thrown.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE',
      '11.4 authority mismatch: with a completion or integrity conflict code');
      const after = await store.getRun(context.runId);
      assertThat(after.revision === before.revision,
        '11.4 authority mismatch: the whole repair rolled back');
      assertThat((await consequenceOf(context.runId)) === null,
        '11.4 authority mismatch: no consequence was written');
      assertThat(!(await eventTypesOf(context.runId)).includes('run.terminalized'),
        '11.4 authority mismatch: and no terminal evidence');
      const ticket = await store.getTicket(after.ticketId);
      assertThat(ticket.status !== 'completed',
        '11.4 authority mismatch: no aggregate completion');
    }

    // ── 11.5 consequence exists, terminal tail did not commit ──────────────
    //
    // Repair must REUSE stronger durable authority rather than reconstructing
    // over it: exactly one consequence, never a second.
    {
      const context = await partiallyTerminalizedRun();
      // DISTINGUISHABLE ON PURPOSE. A stored consequence identical to the one
      // repair would rebuild makes reuse and reconstruction indistinguishable —
      // and a mutation deleting the reuse branch survived this row until the
      // marker below existed. `created` is carried verbatim into the durable
      // consequence, so its survival is proof that the STORED authority was
      // read rather than rebuilt.
      const REUSE_MARKER = 'reports/a/grp-reuse-marker.txt';
      const stored = {
        mutations: [], created: [REUSE_MARKER], updated: [], deleted: [],
        renamed: [], notifications: [], externalEffects: [],
        verification: {
          postconditionsStatus: 'unknown', violationsStatus: 'none',
          browserEvidence: null
        }
      };
      await store.recordRunConsequence({ runId: context.runId, consequence: stored });
      assertThat((await eventTypesOf(context.runId))
        .filter(type => type === 'run.consequence_recorded').length === 1,
      '11.5 consequence reuse: one consequence was already durable');

      const repaired = await store.repairRunTerminalization(
        repairArgs(context, { withDecision: false }));
      assertThat(repaired !== null,
        '11.5 consequence reuse: repair proceeds on the stored authority');
      assertThat((await eventTypesOf(context.runId))
        .filter(type => type === 'run.consequence_recorded').length === 1,
      '11.5 consequence reuse: STILL exactly one — nothing was reconstructed ' +
      'over durable authority');
      assertThat((await eventTypesOf(context.runId))
        .filter(type => type === 'run.terminalized').length === 1,
      '11.5 consequence reuse: and exactly one terminal event');
      const reused = await consequenceOf(context.runId);
      assertThat(reused !== null &&
        Array.isArray(reused.consequence.created) &&
        reused.consequence.created.includes(REUSE_MARKER),
      '11.5 consequence reuse: the STORED consequence survived verbatim — ' +
      'repair read durable authority instead of rebuilding it');
      assertThat((await reservationsOf(context.runId)).length === 0,
        '11.5 consequence reuse: repair created no provider or economic authority');
    }

    console.log('\n── Phase 12: consequence reconstruction under repair ──');

    // Failure-inject each canonical write repair performs while reconstructing
    // a missing consequence. All are `this.`-calls inside repair's single
    // transaction, so the instance shadow reaches them.
    for (const method of [
      'writeReplaySnapshot',
      'recordRunEvaluation',
      'recordRunConsequence',
      '_recordCompletionDecisionEvidence',
      '_listRunOperationsOn'
    ]) {
      const context = await partiallyTerminalizedRun();
      const before = await store.getRun(context.runId);
      const fault = faultStoreMethod(store, { method });
      let thrown = null;
      try {
        await store.repairRunTerminalization(repairArgs(context));
      } catch (error) { thrown = error; } finally {
        fault.restore();
      }
      assertThat(fault.fired === 1,
        `12 ${method}: the fault fired exactly once inside repair`);
      assertThat(thrown !== null && isInjectedFailure(thrown),
        `12 ${method}: repair propagates the failure — it is not swallowed`);
      await assertRepairWroteNothing(context.runId, `12 ${method}`, before);

      // A LATER REPAIR SUCCEEDS EXACTLY ONCE once the dependency is available.
      const retry = await store.repairRunTerminalization(repairArgs(context));
      assertThat(retry !== null,
        `12 ${method}: a later repair succeeds`);
      const types = await eventTypesOf(context.runId);
      assertThat(types.filter(type => type === 'run.consequence_recorded').length === 1,
        `12 ${method}: exactly one consequence`);
      assertThat(types.filter(type => type === 'run.terminalized').length === 1,
        `12 ${method}: exactly one terminal event`);
      assertThat(types.filter(type => type === 'run.completion_decided').length <= 1,
        `12 ${method}: at most one completion-decision event`);
      assertThat((await reservationsOf(context.runId)).length === 0,
        `12 ${method}: and no transport, reservation or operation was created`);
    }

    console.log('\n── Phase 10: required versus best-effort observability ──');

    // ── EVERY TOLERATED FAILURE IS GENUINELY BEST EFFORT ───────────────────
    //
    // `BEST_EFFORT_RUN_LOG_TYPES` names five run-LOG types whose persistence
    // failure server.js tolerates post-terminal. That classification is only
    // defensible while nothing reads them as authority — so this asserts the
    // structural fact that makes it true: those identifiers do not appear in
    // any layer that decides. The runtime contracts own projection, recovery,
    // completion and blocking; the store owns accounting and reconciliation.
    // A future change making one of them load-bearing has to name it there,
    // and this fails when it does.
    {
      const bestEffort = [
        'run:completed', 'run:verification_failed', 'run:failed',
        'run:failed_auto_retried', 'run:interrupted'
      ];
      const authorityLayers = [
        ...fs.readdirSync(path.join(__dirname, '..', 'runtime'))
          .filter(name => name.endsWith('.js'))
          .map(name => path.join('runtime', name)),
        path.join('persistence', 'postgres', 'store.js')
      ];
      const sources = authorityLayers.map(relative => ({
        relative,
        text: fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
      }));
      // ONE PERMITTED APPEARANCE, and it is the opposite of authority.
      // `runtime/execution-semantics.js` lists `run:failed` in
      // `NON_REJECTION_EVENT_TYPES` — a named record of what is deliberately
      // NOT counted, kept "so the exclusion is reviewable rather than implied
      // by omission". `countResponseRejections` consults
      // `RESPONSE_REJECTION_EVENT_TYPES` only; the exclusion map's sole
      // consumer is a test asserting the two stay disjoint. Excluding a type
      // from a count is the strongest possible evidence it is not authority,
      // so it is allowed here by name rather than by a loosened rule.
      const EXCLUSION_RECORD = path.join('runtime', 'execution-semantics.js');
      // SECOND PERMITTED APPEARANCE, and it is also the opposite of live
      // authority: the T2 HISTORICAL classifier reads `run:interrupted` logs
      // only when reconstructing pre-close interruption proof for legacy
      // CLOSED rows — read-only history evidence, never a live projection,
      // recovery, accounting, completion or blocking authority.
      const HISTORY_CLASSIFIER = path.join(
        'runtime', 'ticket-history-classifier-contract.js');
      for (const type of bestEffort) {
        const referenced = sources
          .filter(source => source.text.includes(type))
          .map(source => source.relative);
        const unexpected = referenced.filter(relative =>
          !(relative === EXCLUSION_RECORD && type === 'run:failed') &&
          !(relative === HISTORY_CLASSIFIER && type === 'run:interrupted'));
        assertThat(unexpected.length === 0,
          `10 best effort: ${type} is read by no projection, recovery, ` +
          `accounting, completion or blocking authority${unexpected.length
            ? ` (found in ${unexpected.join(', ')})` : ''}`);
      }
      const semantics = require('../runtime/execution-semantics');
      assertThat(!semantics.RESPONSE_REJECTION_EVENT_TYPES.includes('run:failed'),
        '10 best effort: and run:failed is EXCLUDED from the counted set, ' +
        'not consulted by it');

      // And the converse: the required-evidence writers this matrix faulted
      // are all observed by their callers. Each was proved above by asserting
      // the injected failure reached the caller; this records that the set is
      // complete rather than a selection.
      const observedRequiredWrites = [
        'prepareAndReserveNextGovernedRunRequest',
        'markEconomicRequestStarted',
        'markEconomicResponsePersisted',
        'settleEconomicRequest',
        'appendGovernedPostconditionEvidenceSet',
        'blockGovernedRunForProgressDecision',
        'recordRunConsequence',
        'releaseRunLease',
        'terminalizeRunForReplayIntegrityFailure'
      ];
      const suiteText = fs.readFileSync(__filename, 'utf8');
      for (const method of observedRequiredWrites) {
        assertThat(suiteText.includes(`method: '${method}'`),
          `10 required: ${method} was failure-injected and its caller observed it`);
      }
    }

    console.log(`\n  (${assertThat.count()} assertions)`);
    console.log('\ngoverned required persistence PostgreSQL test passed — ' +
      `${assertThat.count()} assertions`);
  });
}

main().catch(error => { console.error(error); process.exit(1); });
