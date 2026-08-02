-- Tranche 5 — baseline postcondition evaluation, so "newly satisfied" can mean
-- something.
--
-- THE GAP THIS CLOSES. Verified progress is a TRANSITION: a previously
-- unsatisfied admitted fact is now satisfied. Post-batch evidence alone cannot
-- prove a transition, because it cannot say what was true before execution
-- began. Without that, a fact the workspace already satisfied at admission would
-- be observed satisfied in the first batch and credited as progress the Run did
-- not make.
--
-- ADMISSION DOES NOT ALREADY PROVE IT. The execution loop does evaluate the
-- compiled contract before the first provider request, but
-- `checkObjectiveContractPostcondition` completes the Run only when EVERY
-- postcondition is satisfied. A Run with some facts already satisfied and others
-- not proceeds normally, and nothing durable records which were which.
--
-- So one baseline row per eligible fact, captured before the first governed
-- provider request, using the same admitted criterion and the same unified
-- evaluator as every later evaluation.
--
-- A BASELINE IS NOT A BATCH. It has no governed request, no execution step and
-- no operation receipt, because none exist yet. Overloading step 0 to represent
-- it would make the baseline indistinguishable from a real first batch and would
-- collide with that batch's own evidence.

ALTER TABLE governed_postcondition_evidence
  ADD COLUMN evaluation_kind TEXT NOT NULL DEFAULT 'post_batch'
    CHECK (evaluation_kind IN ('baseline', 'post_batch'));

-- A baseline carries no request, step, anchor or receipt count. A post-batch
-- evaluation must carry the request and step that identify its window. Stated as
-- one constraint so the two shapes cannot blur into each other.
ALTER TABLE governed_postcondition_evidence
  ADD CONSTRAINT governed_postcondition_evidence_kind_shape CHECK (
    (
      evaluation_kind = 'baseline'
      AND request_source_identity IS NULL
      AND batch_step_id IS NULL
      AND through_operation_receipt_id IS NULL
      AND evaluated_receipt_count = 0
    ) OR (
      evaluation_kind = 'post_batch'
      AND request_source_identity IS NOT NULL
      AND batch_step_id IS NOT NULL
    )
  );

-- One baseline per fact per Run. A restart re-evaluating the baseline
-- re-reports the existing row rather than appending a second reading of a state
-- that, by definition, existed only once.
CREATE UNIQUE INDEX governed_postcondition_evidence_baseline_unique
  ON governed_postcondition_evidence (run_id, declared_fact_identity)
  WHERE evaluation_kind = 'baseline';

COMMENT ON COLUMN governed_postcondition_evidence.evaluation_kind IS
  'baseline = the state of an admitted fact before the first governed provider '
  'request, so a later satisfied reading can be recognized as a transition '
  'rather than a pre-existing condition. post_batch = a deterministic '
  'evaluation after a committed operation batch. A baseline is never verified '
  'progress.';
