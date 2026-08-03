-- Tranche 5 — bind a started governed request to the exact Run claim that
-- authorized it.
--
-- WHAT WAS WRONG WITH THE ALTERNATIVES.
--
-- `lease_owner` is a PROCESS identity. Two concurrent callers inside one
-- process share it, and a later claim by the same process reuses it, so it
-- cannot distinguish "a duplicate racing a live winner" from "a recovery after
-- a crash" — two situations needing opposite answers.
--
-- The claim TIMESTAMP is not identity either. `clock_timestamp()` has finite
-- resolution: a later claim acquired in the same millisecond as an earlier
-- request start compares as not-earlier, and the recovering caller is told a
-- winner is mid-flight with a request nobody is going to finish. Ordering is
-- also not guaranteed to reflect append order under clock adjustment.
--
-- WHAT THIS RECORDS. `run.lease_acquired` is appended exactly once per
-- acquisition into the append-only, hash-chained event log. Its id is unique
-- per claim, identical for every concurrent caller within that claim, and
-- different for every reacquisition including by the same process. Storing it
-- on the reservation makes "which attempt started this request" a fact rather
-- than an inference.
--
-- NULLABLE BY NECESSITY, NOT BY CHOICE. Reservations started before this
-- migration carry no binding and cannot be given one retroactively — the claim
-- that started them is not recoverable from any surviving record. They are
-- treated conservatively by the runtime rather than assumed current.

ALTER TABLE economic_request_reservations
  ADD COLUMN started_claim_event_position BIGINT;

-- A binding may only exist on a reservation that actually started, and a
-- started reservation created after this migration must carry one. The second
-- half is enforced in the writer rather than here, because pre-existing started
-- rows legitimately have none.
ALTER TABLE economic_request_reservations
  ADD CONSTRAINT economic_request_reservations_claim_binding_shape CHECK (
    started_claim_event_position IS NULL OR started_at IS NOT NULL
  );

COMMENT ON COLUMN economic_request_reservations.started_claim_event_position IS
  'The append-only `position` of the run.lease_acquired event for the Run claim '
  'that started this request. Position is append order, not clock order. '
  'Unique per acquisition, shared by concurrent callers within one claim, and '
  'different for every reacquisition including by the same process owner. NULL '
  'only for reservations started before this binding existed, which the runtime '
  'treats conservatively rather than as belonging to the current claim.';
