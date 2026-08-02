#!/usr/bin/env node
'use strict';

// Tranche 5 — the canonical durable postcondition-evidence substrate.
//
// This suite exists because verified progress had no durable proof to stand on.
// Postcondition results lived only in `replay_snapshots`: one mutable row per
// run, process-clock stamps, no per-item identity — so no cutoff was
// expressible, ordering authority was the process clock, and the row was
// rewritten in place. Every assertion below is about the properties that
// substrate could not provide.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  SUPPORTED_CRITERION_TYPES,
  SUPPORTED_EVALUATORS,
  contentRecordOf,
  buildGovernedPostconditionEvidence,
  normalizeGovernedPostconditionEvidence,
  satisfiedFactIdentitiesByBatch
} = require('../runtime/governed-postcondition-evidence-contract');
const { seedGovernedStructuredTicket } = require('./governed-structured-fixture');

const STAMP = `gpe-${Date.now()}`;
const ACTOR = 'governed-postcondition-evidence-test';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

// The canonical evaluator's verdict shape. Produced by `directPostconditionResult`
// in the completion-decision contract; reproduced here only as the INPUT the
// store is given, never as a second evaluator.
const canonicalVerdict = (passed, type = 'folder_exists') => ({
  type,
  authority: 'objective_contract',
  path: 'reports/a',
  passed,
  reasonCode: passed ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED'
});

async function main() {
  await withHarness('governed postcondition evidence PostgreSQL', async ({ store }) => {
    const seeded = await seedGovernedStructuredTicket(store, {
      stamp: STAMP, actor: ACTOR
    });
    const runId = seeded.runIds[0];
    const siblingRunId = seeded.runIds[1];
    const ticketId = seeded.ticketId;
    const run = await store.getRun(runId);
    const plan = seeded.plan;
    const item = plan.items.find(
      entry => entry.allocationItemId === run.leafRunBinding.allocationItemId);

    const governedAuthorityHash = sha(`governed:${runId}`);
    const completionAuthorityHash = sha(`completion:${runId}`);
    const criterionA = sha('{"path":"reports/a","type":"folder_exists"}');
    const criterionB = sha('{"path":"reports/a/report.md","type":"path_absent"}');

    // A real committed receipt to bind evidence to.
    // Receipts carry the execution step that produced them. That, with run_id,
    // is what validates batch membership — never a receipt id range, because
    // receipt ids are global and interleave across concurrent Runs.
    const insertReceipt = async (targetRunId, targetTicketId, path, key, stepId = '1') =>
      Number((await store.pool.query(
        `INSERT INTO ${store.table('operation_receipts')}
           (run_id, ticket_id, operation, outcome, workspace_path,
            mutation_fingerprint, receipt, idempotency_key, step_id, recorded_at)
         VALUES ($1, $2, 'createFolder', 'succeeded', $3, $4,
                 '{"kind":"fixture"}'::jsonb, $5, $6, clock_timestamp())
         RETURNING id`,
        [targetRunId, targetTicketId, path, `fp-${key}`, `idem-${key}`, stepId]
      )).rows[0].id);

    const receiptOne = await insertReceipt(runId, ticketId, 'reports/a/', `${STAMP}-1`, '1');
    const receiptTwo = await insertReceipt(runId, ticketId, 'reports/a/x', `${STAMP}-2`, '2');

    const evidenceFor = ({
      receiptId = receiptOne,
      factIdentity = criterionA,
      criterionType = 'folder_exists',
      passed = true,
      targetRunId = runId,
      targetTicketId = ticketId,
      itemId = item.allocationItemId,
      authority = governedAuthorityHash,
      completion = completionAuthorityHash,
      logical = 'model-request:agent:1:provider',
      stepId = '1',
      receiptCount = 1
    } = {}) => buildGovernedPostconditionEvidence({
      ticketId: targetTicketId,
      runId: targetRunId,
      allocationPlanId: plan.id,
      allocationItemId: itemId,
      governedAuthorityHash: authority,
      completionAuthorityHash: completion,
      declaredFactIdentity: factIdentity,
      criterionHash: factIdentity,
      criterionType,
      evaluatorIdentity: 'objective_contract',
      evaluatorVersion: 1,
      throughOperationReceiptId: receiptId,
      requestSourceIdentity: logical,
      batchStepId: stepId,
      evaluatedReceiptCount: receiptCount,
      logicalSourceIdentity: logical,
      observedEvidence: { checkedPaths: [{ type: 'folder', path: 'reports/a' }] },
      verdict: canonicalVerdict(passed, criterionType)
    });

    // ── The verdict is the evaluator's, never the caller's ─────────────────
    assert.equal(evidenceFor({ passed: true }).satisfied, true);
    assert.equal(evidenceFor({ passed: false }).satisfied, false);
    assert.throws(
      () => buildGovernedPostconditionEvidence({
        ticketId, runId, allocationPlanId: plan.id,
        allocationItemId: item.allocationItemId,
        governedAuthorityHash, completionAuthorityHash,
        declaredFactIdentity: criterionA, criterionHash: criterionA,
        criterionType: 'folder_exists',
        evaluatorIdentity: 'objective_contract', evaluatorVersion: 1,
        throughOperationReceiptId: receiptOne, requestSourceIdentity: 'model-request:agent:1:provider',
        batchStepId: '1', evaluatedReceiptCount: 1, observedEvidence: {},
        // A model claim, not a canonical verdict.
        verdict: { authority: 'model_response', passed: true, complete: true }
      }),
      error => error.detail.reason === 'postcondition_evidence_not_canonical',
      'a non-canonical verdict cannot become evidence');
    assert.throws(
      () => buildGovernedPostconditionEvidence({
        ticketId, runId, allocationPlanId: plan.id,
        allocationItemId: item.allocationItemId,
        governedAuthorityHash, completionAuthorityHash,
        declaredFactIdentity: criterionA, criterionHash: criterionA,
        criterionType: 'folder_exists',
        evaluatorIdentity: 'objective_contract', evaluatorVersion: 1,
        throughOperationReceiptId: receiptOne, requestSourceIdentity: 'model-request:agent:1:provider',
        batchStepId: '1', evaluatedReceiptCount: 1, observedEvidence: {},
        // The canonical evaluator returns this when it had nothing to read.
        verdict: { authority: 'objective_contract', passed: null,
          reasonCode: 'POSTCONDITION_EVIDENCE_UNAVAILABLE' }
      }),
      error => error.detail.reason === 'postcondition_evidence_not_canonical',
      'absence of evidence is absence of a row, never an unsatisfied record');

    // ── Append: database supplies identity and time ────────────────────────
    const first = await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({ receiptId: receiptOne, factIdentity: criterionA })
    });
    assert.equal(first.alreadyRecorded, false, 'the first append records');
    assert.ok(Number.isSafeInteger(first.evidenceId) && first.evidenceId > 0,
      'the database assigns a monotonic evidence identity');
    assert.match(first.evaluatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      'the database supplies the evaluation instant');
    {
      const dbNow = (await store.pool.query('SELECT clock_timestamp() AS ts')).rows[0].ts;
      assert.ok(
        Math.abs(new Date(dbNow).getTime() - Date.parse(first.evaluatedAt)) < 60_000,
        'the evidence instant is the database clock, not the process clock');
    }

    // ── Idempotency ────────────────────────────────────────────────────────
    const repeat = await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({ receiptId: receiptOne, factIdentity: criterionA })
    });
    assert.equal(repeat.alreadyRecorded, true,
      're-evaluating the same fact on the same receipt records nothing new');
    assert.equal(repeat.evidenceId, first.evidenceId,
      'the stored evidence identity is unchanged');
    assert.equal(
      Number((await store.pool.query(
        `SELECT count(*)::int AS c FROM ${store.table('governed_postcondition_evidence')}
          WHERE run_id = $1`, [runId])).rows[0].c),
      1, 'exactly one row exists after a duplicate append');

    // A CONFLICTING verdict for the same pair refuses rather than becoming a
    // second opinion.
    await assert.rejects(
      () => store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({
          receiptId: receiptOne, factIdentity: criterionA, passed: false })
      }),
      error => error.detail && error.detail.reason === 'postcondition_evidence_conflict',
      'a different verdict for the same fact and receipt is refused');

    // ── Causal binding is enforced against the durable receipt ─────────────
    await assert.rejects(
      () => store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({ receiptId: 9_999_999, factIdentity: criterionB, stepId: '9' })
      }),
      error => error.code === 'GOVERNED_POSTCONDITION_EVIDENCE_RECEIPT_MISSING',
      'evidence cannot cite a receipt that does not exist');

    const foreignReceipt = await insertReceipt(
      siblingRunId, ticketId, 'reports/b/', `${STAMP}-foreign`);
    await assert.rejects(
      () => store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({ receiptId: foreignReceipt, factIdentity: criterionB, stepId: '3' })
      }),
      error => error.code === 'GOVERNED_POSTCONDITION_EVIDENCE_FOREIGN_RECEIPT',
      'evidence cannot cite another Run\'s receipt');

    // ── Ordered, cutoff-bounded reads ──────────────────────────────────────
    const second = await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({
        receiptId: receiptTwo, factIdentity: criterionB,
        criterionType: 'path_absent', stepId: '2' })
    });
    assert.ok(second.evidenceId > first.evidenceId,
      'evidence identity is monotonic');

    const all = await store.readGovernedPostconditionEvidence(runId);
    assert.equal(all.length, 2, 'both records are readable');
    assert.deepEqual(all.map(row => row.evidenceId), [first.evidenceId, second.evidenceId],
      'reads are deterministically ordered by evidence identity');

    const bounded = await store.readGovernedPostconditionEvidence(runId,
      { cutoff: first.evidenceId });
    assert.equal(bounded.length, 1,
      'a cutoff excludes evidence committed after it');
    assert.equal(bounded[0].declaredFactIdentity, criterionA);

    // Evidence committed AFTER a captured cutoff is invisible to that cutoff and
    // visible to a later one — the property the replay snapshot could not offer.
    const capturedCutoff = second.evidenceId;
    const receiptThree = await insertReceipt(
      runId, ticketId, 'reports/a/late', `${STAMP}-3`, '4');
    const late = await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({
        receiptId: receiptThree, stepId: '4',
        factIdentity: sha('{"path":"reports/a/late","type":"folder_exists"}') })
    });
    assert.ok(late.evidenceId > capturedCutoff);
    assert.equal(
      (await store.readGovernedPostconditionEvidence(runId, { cutoff: capturedCutoff })).length,
      2, 'evidence after the captured cutoff is absent from that evaluation');
    assert.equal(
      (await store.readGovernedPostconditionEvidence(runId, { cutoff: late.evidenceId })).length,
      3, 'a later cutoff sees it');

    // ── Stored rows normalize and are hash-protected ───────────────────────
    for (const row of all) {
      assert.ok(contentRecordOf(row),
        'every stored record normalizes through the closed contract');
    }
    // The closed schema is still closed: an unexpected field is not tolerated
    // just because the database-assigned two are.
    assert.throws(() => contentRecordOf({ ...all[0], smuggledField: 1 }),
      /unknown field/, 'the evidence schema remains closed');
    await store.pool.query(
      `UPDATE ${store.table('governed_postcondition_evidence')}
          SET satisfied = false WHERE id = $1`, [first.evidenceId]);
    {
      const tampered = (await store.readGovernedPostconditionEvidence(runId))
        .find(row => row.evidenceId === first.evidenceId);
      assert.throws(() => contentRecordOf(tampered),
        /hash does not cover its own fields/,
        'an edited verdict no longer matches its own evidence hash');
    }
    await store.pool.query(
      `UPDATE ${store.table('governed_postcondition_evidence')}
          SET satisfied = true WHERE id = $1`, [first.evidenceId]);

    // ── The satisfied-fact mapping ─────────────────────────────────────────
    const rows = await store.readGovernedPostconditionEvidence(runId,
      { cutoff: capturedCutoff });
    const mapping = satisfiedFactIdentitiesByBatch(rows, {
      runId,
      allocationItemId: item.allocationItemId,
      governedAuthorityHash,
      completionAuthorityHash
    });
    // Keyed by BATCH, not by receipt: the evaluation was about the batch, and
    // the anchor only locates it in the receipt ordering.
    assert.deepEqual([...(mapping.get('1') || [])], [criterionA],
      'the mapping attributes fact A to the batch it was evaluated in');
    assert.deepEqual([...(mapping.get('2') || [])], [criterionB],
      'and fact B to its own batch');

    // Foreign authority is never credited.
    const foreignAuthorityMapping = satisfiedFactIdentitiesByBatch(rows, {
      runId,
      allocationItemId: item.allocationItemId,
      governedAuthorityHash: sha('a-different-governed-authority'),
      completionAuthorityHash
    });
    assert.equal(foreignAuthorityMapping.size, 0,
      'evidence produced under other authority is never credited');
    const foreignItemMapping = satisfiedFactIdentitiesByBatch(rows, {
      runId,
      allocationItemId: item.allocationItemId + 1000,
      governedAuthorityHash,
      completionAuthorityHash
    });
    assert.equal(foreignItemMapping.size, 0,
      'evidence for another allocation item is never credited');

    // An UNSATISFIED evaluation is durable, and contributes no progress.
    const receiptFour = await insertReceipt(
      runId, ticketId, 'reports/a/no', `${STAMP}-4`, '5');
    const unsatisfiedFact = sha('{"path":"reports/a/no","type":"folder_exists"}');
    await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({
        receiptId: receiptFour, stepId: '5',
        factIdentity: unsatisfiedFact, passed: false })
    });
    const withUnsatisfied = satisfiedFactIdentitiesByBatch(
      await store.readGovernedPostconditionEvidence(runId), {
        runId,
        allocationItemId: item.allocationItemId,
        governedAuthorityHash,
        completionAuthorityHash
      });
    assert.equal(withUnsatisfied.has('5'), false,
      'an unsatisfied evaluation is recorded but never credited as progress');

    // ── The boundary is an ordering anchor, not a causal claim ────────────
    //
    // The execution-time check runs once per step over CUMULATIVE workspace
    // state, so many receipts across many earlier windows contribute to one
    // verdict. The record must not say any single receipt caused the fact.
    {
      const contractSource = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'runtime',
          'governed-postcondition-evidence-contract.js'), 'utf8');
      assert.equal(/operationReceiptId'/.test(contractSource), false,
        'the causal field name is gone');
      assert.ok(contractSource.includes('throughOperationReceiptId'),
        'the boundary is named as an ordering anchor');
      assert.ok(/Not a causal claim/.test(contractSource),
        'the contract states plainly that the anchor is not causal');
    }

    // ── INTERLEAVING: a receipt id range is not a membership set ───────────
    //
    // `operation_receipts.id` is global. Another Run committing between two of
    // this batch's receipts lands numerically inside the range, so anything
    // deriving membership from first..through would silently swallow it.
    // Membership is (run_id, step_id), and this proves the store agrees.
    {
      const batch = '7';
      const mine1 = await insertReceipt(runId, ticketId, 'reports/a/i1', `${STAMP}-i1`, batch);
      const theirs = await insertReceipt(
        siblingRunId, ticketId, 'reports/b/i', `${STAMP}-i2`, batch);
      const mine2 = await insertReceipt(runId, ticketId, 'reports/a/i2', `${STAMP}-i3`, batch);
      assert.ok(mine1 < theirs && theirs < mine2,
        'another Run\'s receipt really does fall inside the numeric range');

      const interleavedFact = sha('{"path":"reports/a/i2","type":"folder_exists"}');
      // Truthful count: only THIS Run's receipts in this batch, which is two.
      const accepted = await store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({
          receiptId: mine2, factIdentity: interleavedFact,
          stepId: batch, receiptCount: 2 })
      });
      assert.equal(accepted.alreadyRecorded, false,
        'the correct count excludes the interleaved foreign receipt');

      // Counting the numeric range instead would have found three.
      const rangeCount = Number((await store.pool.query(
        `SELECT count(*)::int AS c FROM ${store.table('operation_receipts')}
          WHERE id >= $1 AND id <= $2`, [mine1, mine2])).rows[0].c);
      assert.equal(rangeCount, 3,
        'the naive numeric range spans three receipts, one of them foreign');
      assert.notEqual(rangeCount, 2,
        'so range membership and batch membership genuinely differ here');
    }

    // ── A zero-receipt batch borrows no anchor ────────────────────────────
    //
    // An evaluation may follow a batch that committed no qualifying receipt.
    // Saying so is truthful; pointing at an unrelated earlier receipt is not.
    {
      const emptyBatchFact = sha('{"path":"reports/a/empty","type":"path_absent"}');
      const anchorless = await store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({
          receiptId: null, factIdentity: emptyBatchFact,
          criterionType: 'path_absent', stepId: '8', receiptCount: 0 })
      });
      assert.equal(anchorless.evidence.throughOperationReceiptId, null,
        'a zero-receipt batch records no anchor');
      assert.equal(anchorless.evidence.evaluatedReceiptCount, 0,
        'and says it stood on zero receipts');

      // Anchor and count must agree in both directions.
      assert.throws(
        () => evidenceFor({ receiptId: null, factIdentity: emptyBatchFact,
          stepId: '8', receiptCount: 2 }),
        error => error.detail.reason === 'postcondition_evidence_boundary_invalid',
        'a count without an anchor is refused');
      assert.throws(
        () => evidenceFor({ receiptId: receiptOne, factIdentity: emptyBatchFact,
          stepId: '1', receiptCount: 0 }),
        error => error.detail.reason === 'postcondition_evidence_boundary_invalid',
        'an anchor without a count is refused');
    }

    // ── Cross-window and inflated boundaries refuse ───────────────────────
    await assert.rejects(
      () => store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({
          receiptId: receiptOne, factIdentity: sha('cross-window-fact'),
          stepId: '2', receiptCount: 1 })
      }),
      error => error.code === 'GOVERNED_POSTCONDITION_EVIDENCE_CROSS_WINDOW_BOUNDARY',
      'an anchor from another step is a cross-window boundary and refuses');
    await assert.rejects(
      () => store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({
          receiptId: receiptOne, factIdentity: sha('inflated-count-fact'),
          stepId: '1', receiptCount: 9 })
      }),
      error => error.code === 'GOVERNED_POSTCONDITION_EVIDENCE_BOUNDARY_DISAGREEMENT',
      'a count that overstates the batch refuses');

    // Batch identity is mandatory: evidence that cannot name its request cannot
    // be assigned to an observation window at all.
    assert.throws(
      () => buildGovernedPostconditionEvidence({
        ticketId, runId, allocationPlanId: plan.id,
        allocationItemId: item.allocationItemId,
        governedAuthorityHash, completionAuthorityHash,
        declaredFactIdentity: criterionA, criterionHash: criterionA,
        criterionType: 'folder_exists',
        evaluatorIdentity: 'objective_contract', evaluatorVersion: 1,
        throughOperationReceiptId: receiptOne, evaluatedReceiptCount: 1,
        observedEvidence: {}, verdict: canonicalVerdict(true)
      }),
      /requestSourceIdentity/,
      'evidence without a governed request identity is refused');

    // ── The closed vocabularies stay closed ────────────────────────────────
    assert.deepEqual([...SUPPORTED_CRITERION_TYPES],
      ['folder_exists', 'path_absent', 'file_content_equals'],
      'only deterministically decidable criterion types are supported');
    assert.deepEqual(Object.keys(SUPPORTED_EVALUATORS), ['objective_contract'],
      'exactly one canonical evaluator is recognized');

    console.log('  ok governed postcondition evidence');
  });
  console.log('governed postcondition evidence PostgreSQL test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
