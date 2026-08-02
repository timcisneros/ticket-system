-- Tranche 5 — correct the evidence boundary from a causal claim to a truthful
-- ordering anchor plus a durable batch identity.
--
-- WHAT MIGRATION 035 GOT WRONG.
--
-- 035 bound each evidence row to a single `operation_receipt_id` and described
-- it as "the committed receipt this evaluation is about", with a refusal named
-- `causal_binding_missing`. The receipt-causality audit disproved that framing.
--
-- `checkObjectiveContractPostcondition` runs ONCE PER EXECUTION STEP, after the
-- whole action batch, and evaluates CUMULATIVE live workspace state. State
-- produced by many receipts — across many earlier steps and earlier governed
-- request windows — contributes to one verdict. No single receipt caused it.
--
-- The honest claim a single receipt can support is an ORDERING one:
--
--   "the deterministic evaluation occurred after this committed operation
--    boundary, which belongs to this governed request"
--
-- WHY NOT A NUMERIC RECEIPT RANGE. `operation_receipts.id` is GENERATED ALWAYS
-- AS IDENTITY on the whole table, not per Run. Two Runs executing concurrently
-- interleave numerically, so `first_id .. through_id` is NOT a membership set —
-- it can contain another Run's receipts entirely. Treating an ordered pair as a
-- batch would be a silent integrity error that only appears under concurrency.
--
-- WHAT ACTUALLY IDENTIFIES THE BATCH. `operation_receipts.step_id` names the
-- execution step that produced the receipt, and the governed request's canonical
-- logical source identity embeds that same step (`model-request:agent:<step>…`).
-- Membership is therefore validated RELATIONALLY — same run, same step — and
-- never by comparing identifiers.
--
-- So this migration adds the request/batch identity, keeps the anchor but renames
-- it to say only what it means, and records how many receipts the evaluation
-- actually stood on.

ALTER TABLE governed_postcondition_evidence
  RENAME COLUMN operation_receipt_id TO through_operation_receipt_id;

ALTER TABLE governed_postcondition_evidence
  -- The canonical governed request this evaluation belongs to. Same identity
  -- the runtime budget ledger and economic reservations use, so the three
  -- cannot name one request differently.
  ADD COLUMN request_source_identity TEXT,
  -- The execution step that produced the evaluated batch. This — with run_id —
  -- is what validates receipt membership; the numeric anchor never does.
  ADD COLUMN batch_step_id TEXT,
  -- How many committed receipts of that batch the evaluation stood on. Zero is
  -- meaningful and legal: an evaluation may follow a batch that committed no
  -- qualifying receipt, and saying so is more truthful than inventing an anchor.
  ADD COLUMN evaluated_receipt_count INTEGER NOT NULL DEFAULT 0
    CHECK (evaluated_receipt_count >= 0);

-- The anchor becomes optional, because a zero-receipt batch has no committed
-- receipt to point at and must not borrow an unrelated earlier one. When it is
-- present it must be accompanied by a non-zero count, and when it is absent the
-- count must be zero — so the two can never tell different stories.
ALTER TABLE governed_postcondition_evidence
  ALTER COLUMN through_operation_receipt_id DROP NOT NULL;

ALTER TABLE governed_postcondition_evidence
  ADD CONSTRAINT governed_postcondition_evidence_boundary_shape CHECK (
    (through_operation_receipt_id IS NULL AND evaluated_receipt_count = 0)
    OR
    (through_operation_receipt_id IS NOT NULL AND evaluated_receipt_count > 0)
  );

-- Idempotency moves with the boundary. The old constraint keyed on the single
-- receipt; the truthful key is the governed request batch plus the fact, so a
-- second evaluation of the same fact in the same batch is the same evidence
-- however many receipts it stood on.
ALTER TABLE governed_postcondition_evidence
  DROP CONSTRAINT governed_postcondition_evidence_idempotent;

CREATE UNIQUE INDEX governed_postcondition_evidence_batch_fact_unique
  ON governed_postcondition_evidence
     (run_id, batch_step_id, declared_fact_identity)
  WHERE batch_step_id IS NOT NULL;

-- Rows written before this migration carry no batch identity. They remain
-- readable and hash-verifiable under their original semantics; the partial index
-- above simply does not constrain them. No pre-existing evidence is rewritten,
-- because rewriting durable evidence to fit a corrected schema is exactly the
-- kind of silent restatement this table exists to prevent.

CREATE INDEX governed_postcondition_evidence_batch_idx
  ON governed_postcondition_evidence (run_id, batch_step_id);

COMMENT ON COLUMN governed_postcondition_evidence.through_operation_receipt_id IS
  'ORDERING ANCHOR ONLY: the deterministic evaluation occurred after this '
  'committed receipt of this batch. It does NOT claim this receipt alone caused '
  'the fact to be satisfied — the evaluation reads cumulative workspace state.';

COMMENT ON COLUMN governed_postcondition_evidence.request_source_identity IS
  'Canonical governed request identity naming the action batch this evaluation '
  'belongs to. Matches run_budget_charges.source_identity and '
  'economic_request_reservations.logical_source_identity.';

COMMENT ON COLUMN governed_postcondition_evidence.batch_step_id IS
  'Execution step of the evaluated batch. With run_id this validates receipt '
  'membership relationally; receipt id ranges never do, because receipt ids are '
  'global and interleave across concurrent Runs.';

COMMENT ON COLUMN governed_postcondition_evidence.evaluated_receipt_count IS
  'How many committed receipts of the batch the evaluation stood on. Zero is '
  'legal and means no qualifying receipt committed, not that evidence is missing.';
