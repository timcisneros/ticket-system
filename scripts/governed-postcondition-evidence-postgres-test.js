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
  satisfiedFactIdentitiesByReceiptId
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
    const insertReceipt = async (targetRunId, targetTicketId, path, key) =>
      Number((await store.pool.query(
        `INSERT INTO ${store.table('operation_receipts')}
           (run_id, ticket_id, operation, outcome, workspace_path,
            mutation_fingerprint, receipt, idempotency_key, recorded_at)
         VALUES ($1, $2, 'createFolder', 'succeeded', $3, $4,
                 '{"kind":"fixture"}'::jsonb, $5, clock_timestamp())
         RETURNING id`,
        [targetRunId, targetTicketId, path, `fp-${key}`, `idem-${key}`]
      )).rows[0].id);

    const receiptOne = await insertReceipt(runId, ticketId, 'reports/a/', `${STAMP}-1`);
    const receiptTwo = await insertReceipt(runId, ticketId, 'reports/a/x', `${STAMP}-2`);

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
      logical = 'model-request:agent:1:provider'
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
      operationReceiptId: receiptId,
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
        operationReceiptId: receiptOne, observedEvidence: {},
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
        operationReceiptId: receiptOne, observedEvidence: {},
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
        evidence: evidenceFor({ receiptId: 9_999_999, factIdentity: criterionB })
      }),
      error => error.code === 'GOVERNED_POSTCONDITION_EVIDENCE_RECEIPT_MISSING',
      'evidence cannot cite a receipt that does not exist');

    const foreignReceipt = await insertReceipt(
      siblingRunId, ticketId, 'reports/b/', `${STAMP}-foreign`);
    await assert.rejects(
      () => store.appendGovernedPostconditionEvidence({
        evidence: evidenceFor({ receiptId: foreignReceipt, factIdentity: criterionB })
      }),
      error => error.code === 'GOVERNED_POSTCONDITION_EVIDENCE_FOREIGN_RECEIPT',
      'evidence cannot cite another Run\'s receipt');

    // ── Ordered, cutoff-bounded reads ──────────────────────────────────────
    const second = await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({
        receiptId: receiptTwo, factIdentity: criterionB, criterionType: 'path_absent' })
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
    const receiptThree = await insertReceipt(runId, ticketId, 'reports/a/late', `${STAMP}-3`);
    const late = await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({
        receiptId: receiptThree,
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
    const mapping = satisfiedFactIdentitiesByReceiptId(rows, {
      runId,
      allocationItemId: item.allocationItemId,
      governedAuthorityHash,
      completionAuthorityHash
    });
    assert.deepEqual([...(mapping.get(receiptOne) || [])], [criterionA],
      'the mapping attributes fact A to the receipt it was evaluated against');
    assert.deepEqual([...(mapping.get(receiptTwo) || [])], [criterionB],
      'and fact B to its own receipt');

    // Foreign authority is never credited.
    const foreignAuthorityMapping = satisfiedFactIdentitiesByReceiptId(rows, {
      runId,
      allocationItemId: item.allocationItemId,
      governedAuthorityHash: sha('a-different-governed-authority'),
      completionAuthorityHash
    });
    assert.equal(foreignAuthorityMapping.size, 0,
      'evidence produced under other authority is never credited');
    const foreignItemMapping = satisfiedFactIdentitiesByReceiptId(rows, {
      runId,
      allocationItemId: item.allocationItemId + 1000,
      governedAuthorityHash,
      completionAuthorityHash
    });
    assert.equal(foreignItemMapping.size, 0,
      'evidence for another allocation item is never credited');

    // An UNSATISFIED evaluation is durable, and contributes no progress.
    const receiptFour = await insertReceipt(runId, ticketId, 'reports/a/no', `${STAMP}-4`);
    const unsatisfiedFact = sha('{"path":"reports/a/no","type":"folder_exists"}');
    await store.appendGovernedPostconditionEvidence({
      evidence: evidenceFor({
        receiptId: receiptFour, factIdentity: unsatisfiedFact, passed: false })
    });
    const withUnsatisfied = satisfiedFactIdentitiesByReceiptId(
      await store.readGovernedPostconditionEvidence(runId), {
        runId,
        allocationItemId: item.allocationItemId,
        governedAuthorityHash,
        completionAuthorityHash
      });
    assert.equal(withUnsatisfied.has(receiptFour), false,
      'an unsatisfied evaluation is recorded but never credited as progress');

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
