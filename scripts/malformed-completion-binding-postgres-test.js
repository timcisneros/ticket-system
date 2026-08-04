#!/usr/bin/env node
'use strict';

// Tranche 5 — a completion decision that is INTERNALLY VALID but bound to the
// wrong thing.
//
// `malformed-completion-projection-postgres-test` covers the case where a Run
// claims completion with NO decision at all. The three remaining malformed
// shapes are different in kind, and one of them is not what it looks like:
//
//   stale binding          — a well-formed decision naming another Run/Ticket
//   authority mismatch     — a decision whose objective contract is not the
//                            Run's admitted one
//   decision/Run conflict  — a decision asserting `completed` for a Run that
//                            never reached `completed`
//
// REPRESENTABILITY, ESTABLISHED BEFORE WRITING SCENARIOS. These cannot be
// produced by corrupting a stored decision in place: `normalizeCompletionDecision`
// recomputes `decisionHash` over every other field and refuses a mismatch, so
// editing `runId` in the database yields COMPLETION_DECISION_INVALID — a
// different failure than the one under test. The only way to reach the binding
// rules is a decision that is internally consistent and wrongly bound, which is
// built here and stored through the ordinary evidence writer. No trigger,
// constraint, foreign key or append-only protection is disabled.
//
// The distinction that matters: `COMPLETION_EVIDENCE_MISSING` is ONE code
// carrying DIFFERENT closed reasons. A projection that collapsed them would
// still refuse, and would still pass a test that only asserted the code — so
// the reason is asserted every time.

const assert = require('node:assert/strict');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { seedGovernedStructuredTicket } = require('./governed-structured-fixture');
const {
  buildCompletionDecision,
  hashCanonical,
  normalizeCompletionDecision
} = require('../runtime/completion-decision-contract');
const {
  evaluateRunCompletionEvidence
} = require('../runtime/structured-allocation-leaf-run-contract');

const STAMP = `mcb-${Date.now()}`;
const ACTOR = 'malformed-completion-binding-test';

// Rebinds ONE fact and repairs the hash, so the decision stays internally
// valid and the binding rule — not the hash rule — is what refuses it.
function rebound(decision, overrides) {
  const { decisionHash: _ignored, ...rest } = { ...decision, ...overrides };
  return normalizeCompletionDecision({ ...rest, decisionHash: hashCanonical(rest) });
}

async function main() {
  await withHarness('malformed completion binding',
    async ({ store, workspaceRoot }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` }
        ]
      });
      const runId = seeded.runIds[0];
      const siblingRunId = seeded.runIds[1];
      const run = await store.getRun(runId);
      assert.ok(run.completionAuthoritySnapshot,
        'the seeded leaf carries an admitted completion authority');

      // A decision that IS this Run's, used only as the well-formed baseline
      // every corrupted variant is derived from.
      const authorityHash = run.completionAuthoritySnapshot.objectiveContract
        ? hashCanonical(run.completionAuthoritySnapshot.objectiveContract)
        : null;
      // BUILT, NOT HAND-WRITTEN. `decisionHash` is computed over the NORMALIZED
      // decision, so a literal cannot produce a valid hash — the canonical
      // builder is the only way to obtain a well-formed baseline, and every
      // corrupted variant is then derived from it by rebinding one fact.
      const baseline = buildCompletionDecision({
        run: { ...run, status: 'completed' },
        replaySnapshot: {
          events: [],
          parsedModelPlans: [{ complete: true }],
          capabilityOutputs: [],
          browserEvidenceStatus: null,
          browserEvidenceDetail: null
        },
        events: [],
        operations: [],
        consequence: {
          mutations: [], created: [], modified: [], updated: [], deleted: [],
          renamed: [], processOperations: [],
          verification: {
            postconditionsStatus: 'unknown',
            violationsStatus: 'none',
            browserEvidence: null
          }
        },
        verificationContract: null,
        evaluatedAt: '2026-08-04T00:00:00.000Z'
      });

      console.log('  (baseline decision constructed)');
      console.log(`  ok baseline binds run ${baseline.runId} ticket ${baseline.ticketId}`);
      assertThat(baseline.runId === runId && baseline.ticketId === run.ticketId,
        'the baseline decision is genuinely this Run’s');

      // ── THE PURE RULE, PINNED ALONGSIDE THE PRODUCTION ONE ──────────────
      //
      // Each production case below has its evaluator counterpart asserted with
      // the SAME data, so a projection that stopped consulting the shared rule
      // could not silently keep passing.
      const evaluate = (runStatus, decision, hash = null) =>
        evaluateRunCompletionEvidence({
          runStatus,
          runId,
          runTicketId: run.ticketId,
          runCompletionAuthorityHash: hash,
          decision
        });

      const staleByRun = rebound(baseline, { runId: siblingRunId });
      const staleByTicket = rebound(baseline, { ticketId: run.ticketId + 100000 });
      const mismatched = rebound(baseline, { objectiveContractHash: 'e'.repeat(64) });
      // The builder returns `incomplete` for a model-only claim — model
      // completion is not authority — so the conflict case states the
      // disposition explicitly rather than assuming the baseline asserts one.
      const conflicting = rebound(baseline, { completionDisposition: 'completed' });

      assertThat(evaluate('completed', staleByRun).reason === 'completion_decision_stale',
        'the shared rule calls a decision bound to another Run stale');
      assertThat(evaluate('completed', staleByTicket).reason === 'completion_decision_stale',
        'and one bound to another Ticket stale');
      assertThat(
        evaluate('completed', mismatched, authorityHash).reason ===
          'completion_authority_mismatch',
        'an authority mismatch is reported ONLY when a hash is supplied to compare');
      assertThat(evaluate('completed', mismatched, null).reason === 'completion_verified',
        'and a null comparison hash is deliberately NOT a mismatch');
      assertThat(evaluate('failed', conflicting).reason ===
        'completion_decision_conflicts_run',
        'a decision claiming completion for a non-completed Run conflicts');

      // ── PRODUCTION PROJECTION MEETS EACH ONE ────────────────────────────
      //
      // ONE MALFORMED DECISION PER RUN, BY CONSTRUCTION. `run_consequences` is
      // keyed by `run_id`, requires its `ticket_id` to match the Run's, and is
      // append-only — the evidence-mutation trigger refuses UPDATE and DELETE.
      // So a case cannot be staged by overwriting the previous one; each needs
      // its own freshly admitted Run. That is defence in depth, recorded rather
      // than worked around.
      const setRunStatus = async (targetRunId, status) => {
        const current = (await store.pool.query(
          `SELECT status FROM ${store.table('runs')} WHERE id = $1`,
          [targetRunId])).rows[0].status;
        if (current !== 'running') {
          await store.pool.query(
            `UPDATE ${store.table('runs')}
                SET status = 'running', current_phase = 'mutation',
                    body = body || jsonb_build_object('status', 'running'),
                    started_at = COALESCE(started_at, clock_timestamp()),
                    completed_at = NULL, revision = revision + 1
              WHERE id = $1`, [targetRunId]);
        }
        await store.pool.query(
          `UPDATE ${store.table('runs')}
              SET status = $2, current_phase = 'terminalization',
                  body = body || jsonb_build_object('status', $2::text),
                  completed_at = COALESCE(completed_at, clock_timestamp()),
                  lease_owner = NULL, lease_expires_at = NULL,
                  revision = revision + 1
            WHERE id = $1`, [targetRunId, status]);
      };
      // THROUGH THE ORDINARY EVIDENCE WRITER, not a raw insert. It is the same
      // call production uses, so the terminal-run guard, the append-only
      // protection and the completion-evidence event all apply exactly as they
      // normally do. Only the decision's BINDING is wrong, which is the fact
      // under test.
      const storeDecision = async (targetRunId, _targetTicketId, decision) => {
        await store.recordRunConsequence({
          runId: targetRunId,
          consequence: { completionDecision: decision },
          eventPayload: { source: ACTOR }
        });
      };

      // A fresh admitted leaf per case.
      let leafSeq = 0;
      const freshLeaf = async label => {
        leafSeq += 1;
        const admitted = await seedGovernedStructuredTicket(store, {
          stamp: `${STAMP}-${leafSeq}-${label}`,
          actor: ACTOR,
          workspaceRoot,
          leafPostconditions: (item, owned) => [
            { type: 'folder_exists', path: `${owned}/alpha` }
          ]
        });
        const leafRun = await store.getRun(admitted.runIds[0]);
        return { admitted, leafRun };
      };

      for (const [label, corrupt, expectedReason] of [
        ['a decision bound to another Run',
          (leaf) => rebound(baseline, { runId: leaf.id + 9999, ticketId: leaf.ticketId }),
          'completion_decision_stale'],
        ['a decision bound to another Ticket',
          (leaf) => rebound(baseline, { runId: leaf.id, ticketId: leaf.ticketId + 9999 }),
          'completion_decision_stale']
      ]) {
        const { leafRun } = await freshLeaf(label.replace(/[^a-z]/gi, '').slice(0, 8));
        await setRunStatus(leafRun.id, 'completed');
        await storeDecision(leafRun.id, leafRun.ticketId, corrupt(leafRun));

        const before = (await store.pool.query(
          `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
          [leafRun.ticketId])).rows[0].status;
        let refusal = null;
        try {
          await store.transitionTicketAfterRun({ runId: leafRun.id });
        } catch (error) { refusal = error; }

        assertThat(refusal !== null, `${label} is REFUSED by the real projection`);
        assertThat(refusal.code === 'COMPLETION_EVIDENCE_MISSING',
          `${label} refuses with the canonical code (${refusal.code})`);
        assertThat(refusal.completionEvidenceReason === expectedReason,
          `${label} preserves the EXACT reason ${expectedReason}, got ` +
          `${refusal.completionEvidenceReason}`);
        const after = (await store.pool.query(
          `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
          [leafRun.ticketId])).rows[0].status;
        assertThat(after === before, `${label} projects no completion`);
        const count = Number((await store.pool.query(
          `SELECT count(*) AS n FROM ${store.table('run_consequences')} WHERE run_id = $1`,
          [leafRun.id])).rows[0].n);
        assertThat(count === 1, `${label} causes no second, synthesized decision`);
      }

      // AUTHORITY MISMATCH IS NOT OBSERVABLE HERE, AND THAT IS DELIBERATE.
      //
      // Ticket projection passes `runCompletionAuthorityHash: null` — it holds
      // no item binding and supplies none — and the shared rule treats a null
      // comparison as "no opinion" rather than a mismatch, so it does not refuse
      // Runs nobody holds evidence against. The mismatch rule belongs to
      // allocation-item reconciliation, which does supply the hash, and is
      // asserted against the evaluator with the hash present above. Claiming a
      // Ticket-projection refusal here would describe a refusal this surface
      // does not make.
      {
        const { leafRun } = await freshLeaf('mismatch');
        await setRunStatus(leafRun.id, 'completed');
        await storeDecision(leafRun.id, leafRun.ticketId,
          rebound(baseline, {
            runId: leafRun.id, ticketId: leafRun.ticketId,
            objectiveContractHash: 'e'.repeat(64)
          }));
        let refusal = null;
        try {
          await store.transitionTicketAfterRun({ runId: leafRun.id });
        } catch (error) { refusal = error; }
        assertThat(refusal === null,
          'Ticket projection does NOT refuse an authority mismatch — it compares no hash');
      }

      // ── DECISION CONFLICTS WITH RUN STATUS ──────────────────────────────
      {
        const { leafRun } = await freshLeaf('conflict');
        await setRunStatus(leafRun.id, 'failed');
        const conflict = rebound(baseline, {
          runId: leafRun.id, ticketId: leafRun.ticketId,
          completionDisposition: 'completed'
        });
        await storeDecision(leafRun.id, leafRun.ticketId, conflict);

        let refusal = null;
        try {
          await store.transitionTicketAfterRun({ runId: leafRun.id });
        } catch (error) { refusal = error; }
        assertThat(refusal !== null,
          'a decision claiming completion for a FAILED Run is REFUSED');
        assertThat(refusal.completionEvidenceReason === 'completion_decision_conflicts_run',
          `and preserves the conflict reason (${refusal.completionEvidenceReason})`);
        assertThat((await store.getRun(leafRun.id)).status !== 'completed',
          'and the Run itself never claims completion');

        // A terminal Run may not be reopened to restage the case — recorded as
        // part of the representability finding, not worked around.
        let reopen = null;
        try { await setRunStatus(leafRun.id, 'completed'); } catch (error) { reopen = error; }
        assertThat(reopen !== null,
          'a terminal Run cannot be reopened to restage a different malformed case');
      }

      console.log(`\nmalformed completion binding test passed — ` +
        `${assertThat.count()} assertions`);
    });
}

main().catch(error => { console.error(error); process.exit(1); });
