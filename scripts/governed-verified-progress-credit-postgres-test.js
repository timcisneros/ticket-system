#!/usr/bin/env node
'use strict';

// Tranche 5 — production credits verified progress from durable evidence.
//
// This is the suite the whole evidence layer exists for. Production used to pass
// a null satisfied-fact mapping, so `verifiedProgressCount` was structurally
// zero and a Run that genuinely advanced was still stopped and told
// `verified_progress_exhausted` — a persisted reason that was false about its
// work. Every assertion here drives the store-owned derivation; nothing supplies
// a satisfied fact from outside.

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');
const {
  seedGovernedStructuredTicket,
  seedGovernedBaselineEvidence
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');
const {
  buildGovernedPostconditionEvidence
} = require('../runtime/governed-postcondition-evidence-contract');
const {
  evaluateGovernedRunProgress
} = require('../runtime/governed-progress-evaluation');

const STAMP = `vpc-${Date.now()}`;
const ACTOR = 'governed-verified-progress-credit-test';

async function main() {
  await withHarness('governed verified progress credit PostgreSQL', async ({ store }) => {
    const seeded = await seedGovernedStructuredTicket(store, { stamp: STAMP, actor: ACTOR });
    const runId = seeded.runIds[0];
    const run = await store.getRun(runId);
    const facts = eligibleExecutionFacts(run);
    assert.equal(facts.length, 1, 'the seeded Run admits one eligible fact');
    const fact = facts[0];

    // Scenario A — baseline false.
    await seedGovernedBaselineEvidence(store, runId, { satisfied: false });
    const before = await store.readGovernedFactTransitions(runId);
    assert.deepEqual([...before.baselineUnsatisfiedFactIdentities],
      [fact.declaredFactIdentity], 'the baseline records the fact unsatisfied');
    assert.deepEqual([...before.newlyVerifiedFactIdentities], [],
      'nothing is credited before any batch');

    const postBatch = async (step, satisfied) => {
      const receiptId = Number((await store.pool.query(
        `INSERT INTO ${store.table('operation_receipts')}
           (run_id, ticket_id, operation, outcome, workspace_path,
            mutation_fingerprint, receipt, idempotency_key, step_id, recorded_at)
         VALUES ($1,$2,'createFolder','succeeded',$3,$4,
                 '{"kind":"credit"}'::jsonb,$5,$6,clock_timestamp())
         RETURNING id`,
        [runId, run.ticketId, fact.criterion.path, `fp-${STAMP}-${step}`,
          `idem-${STAMP}-${step}`, String(step)]
      )).rows[0].id);
      await store.appendGovernedPostconditionEvidenceSet({
        evidenceRecords: [buildGovernedPostconditionEvidence({
          ticketId: run.ticketId, runId, allocationPlanId: run.allocationPlanId,
          allocationItemId: run.leafRunBinding.allocationItemId,
          governedAuthorityHash: run.governedExecution.progressControlPolicy.policyHash,
          completionAuthorityHash: fact.completionAuthorityHash,
          declaredFactIdentity: fact.declaredFactIdentity,
          criterionHash: fact.criterionHash,
          criterionType: fact.criterionType,
          evaluatorIdentity: fact.evaluatorIdentity,
          evaluatorVersion: fact.evaluatorVersion,
          evaluationKind: 'post_batch',
          batchStepId: String(step),
          requestSourceIdentity: `model-request:agent:${step}:provider`,
          throughOperationReceiptId: receiptId,
          evaluatedReceiptCount: 1,
          observedEvidence: {
            path: fact.criterion.path,
            observedKind: satisfied ? 'folder' : 'absent'
          },
          verdict: {
            type: fact.criterionType, authority: 'objective_contract',
            path: fact.criterion.path, passed: satisfied,
            reasonCode: satisfied
              ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED'
          }
        })]
      });
      return receiptId;
    };

    // Scenario A — first satisfaction is credited.
    const firstReceipt = await postBatch(1, true);
    const afterFirst = await store.readGovernedFactTransitions(runId);
    assert.deepEqual([...afterFirst.newlyVerifiedFactIdentities],
      [fact.declaredFactIdentity], 'the first false-to-true transition is credited');
    assert.deepEqual(
      [...afterFirst.satisfiedFactIdentitiesByReceiptId.get(firstReceipt)],
      [fact.declaredFactIdentity],
      'and reaches the mapping keyed by the window\'s truthful anchor');

    // THE CLAIM THIS LAYER EXISTS FOR: the evaluator now sees real progress,
    // derived from durable rows, with no caller supplying anything.
    const state = await store.readGovernedRunProgressState(runId);
    const evaluated = evaluateGovernedRunProgress({
      progressState: state,
      declaredWorkSnapshot: run.declaredWorkSnapshot,
      progressPolicy: run.governedExecution.progressControlPolicy,
      allocationPlanId: run.allocationPlanId,
      allocationItemId: run.allocationItemId,
      satisfiedFactIdentitiesByReceiptId: afterFirst.satisfiedFactIdentitiesByReceiptId
    });
    assert.ok(afterFirst.satisfiedFactIdentitiesByReceiptId.size > 0,
      'PRODUCTION DERIVES A NON-EMPTY SATISFIED-FACT MAPPING');
    assert.ok(evaluated.decision, 'the churn decision is produced from it');

    // Scenario B — repeated satisfaction credits nothing further.
    await postBatch(2, true);
    const afterRepeat = await store.readGovernedFactTransitions(runId);
    assert.deepEqual([...afterRepeat.newlyVerifiedFactIdentities],
      [fact.declaredFactIdentity],
      'observing the same fact satisfied again credits nothing new');
    assert.deepEqual([...afterRepeat.windows[1].newlySatisfiedFactIdentities], []);
    assert.deepEqual([...afterRepeat.windows[1].repeatedSatisfiedFactIdentities],
      [fact.declaredFactIdentity]);

    // Scenario F — false then true again is still exactly one credit.
    await postBatch(3, false);
    await postBatch(4, true);
    const afterCycle = await store.readGovernedFactTransitions(runId);
    assert.equal(afterCycle.newlyVerifiedFactIdentities.length, 1,
      'reaching the same state again is not a second advancement');
    assert.equal(afterCycle.creditedInBatch[fact.declaredFactIdentity], '1',
      'the credit stays attributed to the window that earned it');

    // Scenario I — evidence after the cutoff is invisible; a later cutoff sees it.
    const baselineMax = Number((await store.pool.query(
      `SELECT max(id) AS m FROM ${store.table('governed_postcondition_evidence')}
        WHERE run_id = $1 AND evaluation_kind = 'baseline'`, [runId])).rows[0].m);
    const bounded = await store.readGovernedFactTransitions(runId, {
      cutoff: { ...state.cutoff, postconditionEvidenceCutoff: baselineMax,
        receiptCutoff: 0 }
    });
    assert.deepEqual([...bounded.newlyVerifiedFactIdentities], [],
      'evidence committed after the cutoff is invisible to that evaluation');

    // A cutoff that cannot see the baseline is an integrity refusal, never a
    // silent zero — the two must not be confusable.
    await assert.rejects(
      () => store.readGovernedFactTransitions(runId, {
        cutoff: { ...state.cutoff, postconditionEvidenceCutoff: 0, receiptCutoff: 0 }
      }),
      error => error.detail && error.detail.reason === 'fact_baseline_incomplete',
      'an evaluation that cannot see the baseline refuses');

    // Scenario H — a receipt-bearing batch missing verdicts is an integrity
    // refusal, not an ordinary no-progress window.
    await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
         (run_id, ticket_id, operation, outcome, workspace_path,
          mutation_fingerprint, receipt, idempotency_key, step_id, recorded_at)
       VALUES ($1,$2,'createFolder','succeeded','other/','fp-partial',
               '{"kind":"partial"}'::jsonb,$3,'9',clock_timestamp())`,
      [runId, run.ticketId, `idem-partial-${STAMP}`]);
    await assert.rejects(
      () => store.readGovernedFactTransitions(runId),
      error => error.detail && error.detail.reason === 'fact_evidence_incomplete',
      'a batch that committed receipts but recorded no verdict refuses');

    // Scenario E — a pre-existing satisfied fact is never this Run's progress.
    const other = seeded.runIds[1];
    await seedGovernedBaselineEvidence(store, other, { satisfied: true });
    const otherRun = await store.getRun(other);
    const otherFact = eligibleExecutionFacts(otherRun)[0];
    const otherReceipt = Number((await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
         (run_id, ticket_id, operation, outcome, workspace_path,
          mutation_fingerprint, receipt, idempotency_key, step_id, recorded_at)
       VALUES ($1,$2,'createFolder','succeeded',$3,'fp-pre',
               '{"kind":"pre"}'::jsonb,$4,'1',clock_timestamp())
       RETURNING id`,
      [other, otherRun.ticketId, otherFact.criterion.path, `idem-pre-${STAMP}`]
    )).rows[0].id);
    await store.appendGovernedPostconditionEvidenceSet({
      evidenceRecords: [buildGovernedPostconditionEvidence({
        ticketId: otherRun.ticketId, runId: other,
        allocationPlanId: otherRun.allocationPlanId,
        allocationItemId: otherRun.leafRunBinding.allocationItemId,
        governedAuthorityHash:
          otherRun.governedExecution.progressControlPolicy.policyHash,
        completionAuthorityHash: otherFact.completionAuthorityHash,
        declaredFactIdentity: otherFact.declaredFactIdentity,
        criterionHash: otherFact.criterionHash,
        criterionType: otherFact.criterionType,
        evaluatorIdentity: otherFact.evaluatorIdentity,
        evaluatorVersion: otherFact.evaluatorVersion,
        evaluationKind: 'post_batch', batchStepId: '1',
        requestSourceIdentity: 'model-request:agent:1:provider',
        throughOperationReceiptId: otherReceipt, evaluatedReceiptCount: 1,
        observedEvidence: { path: otherFact.criterion.path, observedKind: 'folder' },
        verdict: {
          type: otherFact.criterionType, authority: 'objective_contract',
          path: otherFact.criterion.path, passed: true,
          reasonCode: 'POSTCONDITION_PASSED'
        }
      })]
    });
    const preExisting = await store.readGovernedFactTransitions(other);
    assert.deepEqual([...preExisting.baselineSatisfiedFactIdentities],
      [otherFact.declaredFactIdentity]);
    assert.deepEqual([...preExisting.newlyVerifiedFactIdentities], [],
      'a fact already true before the Run began is never credited to it');
    assert.equal(preExisting.satisfiedFactIdentitiesByReceiptId.size, 0);

    // Scenario J — restart reconstructs identically and double-credits nothing.
    {
      const { PostgresRuntimeStore } = require('../persistence/postgres/store');
      const restarted = new PostgresRuntimeStore({
        connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
      try {
        const again = await restarted.readGovernedFactTransitions(other);
        assert.deepEqual([...again.newlyVerifiedFactIdentities],
          [...preExisting.newlyVerifiedFactIdentities],
          'a restart reconstructs the same fact history');
      } finally {
        await restarted.close();
      }
    }

    console.log('  ok governed verified progress credit');
  });
  console.log('governed verified progress credit PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
