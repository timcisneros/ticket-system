-- Tranche 4 — durable logical-request identity for governed requests.
--
-- THE DEFECT THIS CLOSES.
--
-- Migration 033 made reservations unique on
--   (ticket_id, role, run_id, model_request_ordinal)
-- which is uniqueness of the ORDINAL, not of the request. Two concurrent
-- orchestrations of the SAME logical model request therefore both succeeded:
-- the shared account lock serialized them, the second read the ledger the first
-- had just written, and took the next ordinal. Duplicate execution of one
-- logical request silently became requests 1 and 2 — two reservations, two
-- charges, and eventually two provider calls for work that should have happened
-- once.
--
-- Account locking proves ECONOMIC serialization. It cannot prove LOGICAL
-- uniqueness, because it has no idea the two callers meant the same request.
--
-- THE IDENTITY IS NOT NEW. The runtime budget ledger already names each model
-- request opportunity durably:
--
--   run_budget_charges.source_identity = 'model-request:<evidence slot>'
--   UNIQUE (run_id, dimension, source_identity)
--
-- The evidence slot is derived from the Run's durable execution step, so it is
-- stable across a restart and identical for two callers replaying the same
-- state. Reusing it — rather than inventing a second counter that could drift
-- from the first — is the whole point of this migration:
--
--   one canonical model-request source
--     -> one runtime-budget reservation
--     -> one economic reservation
--     -> one ordinal
--
-- Nullable, because planner reservations and every reservation written before
-- this migration have no worker evidence slot. The constraint below is a
-- partial unique index for exactly that reason: it binds worker requests that
-- carry an identity and ignores those that cannot have one.

ALTER TABLE economic_request_reservations
  ADD COLUMN logical_source_identity TEXT
    CHECK (
      logical_source_identity IS NULL OR
      length(btrim(logical_source_identity)) BETWEEN 1 AND 512
    );

-- ONE RESERVATION PER LOGICAL REQUEST, enforced by the database rather than by
-- application discipline. A duplicate concurrent preparation loses here and is
-- re-reported as the reservation that already exists, instead of being handed
-- the next ordinal.
--
-- A partial index rather than a table constraint: NULL identities (planner
-- subjects, historical rows) must remain unconstrained, and a plain UNIQUE
-- would treat every NULL as distinct anyway while still requiring the column on
-- every future row.
CREATE UNIQUE INDEX economic_request_reservations_logical_source_unique
  ON economic_request_reservations (run_id, role, logical_source_identity)
  WHERE logical_source_identity IS NOT NULL;

COMMENT ON COLUMN economic_request_reservations.logical_source_identity IS
  'Canonical model-request source identity, matching run_budget_charges.source_identity, '
  'so one logical request can never receive two ordinals.';
