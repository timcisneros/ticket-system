-- T2 Tranche 5 — atomic five-state Ticket lifecycle cutover.
--
-- Executes INSIDE the migration transaction, AFTER the JS hook
-- (t041-five-state-backfill.js) has:
--   H1  locked the eight relations IN SHARE ROW EXCLUSIVE MODE NOWAIT,
--   H2  loaded the locked fact set,
--   H3  classified EVERY Ticket through the amended pure contract,
--   H4  built TEMP t041_ticket_lifecycle_projection (desired status +
--       desired cancellation authority for EVERY Ticket) and refused any
--       ambiguous/integrity-contradiction row,
--   H5  recorded source digests into TEMP t041_identity.
--
-- Any failure anywhere rolls the WHOLE migration back; no partial state and
-- no ledger row can survive.

-- ── Q1: source-identity binding ────────────────────────────────────────────
-- The ledger pins THIS file's bytes; these literals pin the FULL file-level
-- relative-require closure of the hook's semantic roots (13 modules — see
-- scripts/t041-semantic-closure-test.js, which walks require edges and fails
-- on any divergence). Over-binding symbol-inert siblings is deliberate: it
-- can only widen drift detection. Drift in any bound source after shipping
-- would otherwise silently redefine what "running 041" means.
DO $block$
DECLARE
  mismatch TEXT;
BEGIN
  SELECT string_agg(identity.label || '=' || identity.actual_sha256, ', ')
    INTO mismatch
    FROM t041_identity AS identity
   WHERE NOT EXISTS (
     SELECT 1 FROM (VALUES
       ('t041-five-state-backfill.js', 'b937a893b8cf3f61f218cc2e0e9067012962c682112a8e1d783d87868d83e5db'),
       ('allocation-plan-contract.js', 'a0c56f5944f179d5aff57bc873f8f20cc5aa2fce854d8731ca69896f41e948ba'),
       ('authority-paths.js', '087ea0983b6138bdf6681f2f239cc52879458d5a0bb01096b0c9b02228420bcb'),
       ('completion-decision-contract.js', '5877d9c148f51c2c6e9d76ba8442237f700adce1d83a71552e7ae6dc9da88c89'),
       ('declared-work-contract.js', '50e0d6e1ed37a029b1606ef89a45c1738430bafb09b7eaffcdcdac515ef0674c'),
       ('postcondition-criterion-evaluator.js', 'b9a93867b26f9749150eb3b14a6aad290ea0e3878e7750398225fc0b9bb2f472'),
       ('structured-allocation-leaf-run-contract.js', '2507f155f64b8858125f35b70ce3d184bd6e5184c5814b717dc1efdf98446819'),
       ('ticket-attempt-completion-contract.js', '13c8064b8811384520b0cc0c984b9adf9797cc353f551e95e3cf22b265c33950'),
       ('ticket-attempt-contract.js', '6cde428138d8f04883ee8f8031fc525c5b096a211ce5793978135bea158d2c98'),
       ('ticket-blocking-authority-composer.js', '73046a248e7a236d9058933e41ecd3ee5462a80d15049db96a8bfd2b98b5df8c'),
       ('ticket-cancellation-authority-contract.js', 'f1f3c8d0e2cc84f070a49ea27e842f03a20d2e5da4c5608e53db7d294d252676'),
       ('ticket-history-classifier-contract.js', '6a34495d7678b7d0c4032c8f9620afc2acd52b2fb43f44d3fac390b9ff190507'),
       ('ticket-lifecycle-contract.js', '11cb34d651912c96446ccce13c8024b1bd960a536f4b114d77bf0863e70422d8')
     ) AS expected(label, sha256)
      WHERE expected.label = identity.label
        AND expected.sha256 = identity.actual_sha256
   );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION '041 source identity drift: %', mismatch;
  END IF;
  IF (SELECT COUNT(*) FROM t041_identity) <> 13 THEN
    RAISE EXCEPTION '041 identity table incomplete';
  END IF;
END;
$block$;

-- ── Q2: drop the legacy six-state status CHECK ─────────────────────────────
-- Discovered from the catalog by signature, never by assumed name. Must
-- precede any write of 'canceled' (the known ordering trap).
DO $block$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
    FROM pg_constraint AS con
    JOIN pg_attribute AS attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY (con.conkey)
     AND attr.attname = 'status'
   WHERE con.conrelid = 'tickets'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) LIKE '%in_progress%'
     AND pg_get_constraintdef(con.oid) LIKE '%closed%'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'legacy tickets.status CHECK constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'tickets', constraint_name);
END;
$block$;

-- ── Q3: drop the legacy counter identity ───────────────────────────────────
-- Must precede Q4: the per-row counter trigger fires during the conversion
-- and must be able to insert 'canceled' count rows.
ALTER TABLE runtime_status_counts DROP CONSTRAINT runtime_status_counts_identity;

-- ── Q4: minimal desired-projection materialization ─────────────────────────
-- Authority-first: EVERY Ticket is written from its classified desired row.
-- A row is touched only when a canonical persisted value actually changes;
-- unchanged Tickets keep revision/updated_at byte-exact. Existing migration-
-- 040 authorities are preserved verbatim (the hook guarantees
-- desired_cancellation_authority equals the existing value whenever one is
-- present), so the 040 immutability trigger never sees a replacement.
UPDATE tickets AS t
SET status = p.desired_status,
    cancellation_authority = p.desired_cancellation_authority,
    revision = t.revision + 1,
    updated_at = clock_timestamp()
FROM t041_ticket_lifecycle_projection AS p
WHERE t.id = p.ticket_id
  AND (
    t.status <> p.desired_status
    OR p.desired_cancellation_authority IS DISTINCT FROM t.cancellation_authority
  );

-- ── Q5: ticket counter reseed from converted reality ───────────────────────
DELETE FROM runtime_status_counts WHERE entity_type = 'ticket';

INSERT INTO runtime_status_counts (entity_type, status, shard, count)
SELECT 'ticket', status, mod(id, 256)::smallint, COUNT(*)::bigint
FROM tickets
GROUP BY status, mod(id, 256);

-- ── Q6: five-state counter identity ────────────────────────────────────────
ALTER TABLE runtime_status_counts
  ADD CONSTRAINT runtime_status_counts_identity CHECK (
    shard >= 0 AND shard < 256 AND (
      (entity_type = 'ticket' AND status IN
        ('open', 'in_progress', 'blocked', 'completed', 'canceled')) OR
      (entity_type = 'run' AND status IN
        ('pending', 'running', 'completed', 'failed', 'interrupted'))
    )
  );

-- ── Q7: five-state Ticket CHECK (explicitly named) ─────────────────────────
ALTER TABLE tickets
  ADD CONSTRAINT tickets_status_check CHECK (
    status IN ('open', 'in_progress', 'blocked', 'completed', 'canceled')
  );

-- ── Q8: convergence/integrity assertions ───────────────────────────────────
DO $block$
DECLARE
  legacy_rows BIGINT;
  orphan_canceled BIGINT;
  authority_without_canceled BIGINT;
  bad_authority BIGINT;
  nonconverged BIGINT;
  counter_drift BIGINT;
  run_counter_drift BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_rows FROM tickets
   WHERE status NOT IN ('open', 'in_progress', 'blocked', 'completed', 'canceled');
  IF legacy_rows <> 0 THEN
    RAISE EXCEPTION '041 validation: % ticket row(s) outside the five-state vocabulary', legacy_rows;
  END IF;

  SELECT COUNT(*) INTO orphan_canceled FROM tickets WHERE status = 'canceled' AND cancellation_authority IS NULL;
  SELECT COUNT(*) INTO authority_without_canceled FROM tickets WHERE status <> 'canceled' AND cancellation_authority IS NOT NULL;
  IF orphan_canceled <> 0 OR authority_without_canceled <> 0 THEN
    RAISE EXCEPTION '041 validation: canceled/authority coherence violated (% / %)', orphan_canceled, authority_without_canceled;
  END IF;

  SELECT COUNT(*) INTO bad_authority FROM tickets
   WHERE cancellation_authority IS NOT NULL
     AND validate_ticket_cancellation_authority_shape(cancellation_authority, id) IS NOT TRUE;
  IF bad_authority <> 0 THEN
    RAISE EXCEPTION '041 validation: % malformed cancellation authorit(y/ies)', bad_authority;
  END IF;

  -- Every Ticket converges with its classified desired row.
  SELECT COUNT(*) INTO nonconverged
    FROM tickets AS t
    JOIN t041_ticket_lifecycle_projection AS p ON p.ticket_id = t.id
   WHERE t.status <> p.desired_status
      OR p.desired_cancellation_authority IS DISTINCT FROM t.cancellation_authority;
  IF nonconverged <> 0 THEN
    RAISE EXCEPTION '041 validation: % ticket(s) did not converge with their classification', nonconverged;
  END IF;
  IF (SELECT COUNT(*) FROM t041_ticket_lifecycle_projection)
     <> (SELECT COUNT(*) FROM tickets) THEN
    RAISE EXCEPTION '041 validation: projection does not cover every ticket';
  END IF;

  -- Ticket counters equal grouped reality per shard.
  SELECT COUNT(*) INTO counter_drift
    FROM (
      SELECT status, mod(id, 256)::smallint AS shard, COUNT(*)::bigint AS c
      FROM tickets GROUP BY status, mod(id, 256)
    ) AS reality
    FULL OUTER JOIN (
      SELECT status, shard, count
      FROM runtime_status_counts WHERE entity_type = 'ticket'
    ) AS counter
      ON counter.status = reality.status
     AND counter.shard = reality.shard
   WHERE counter.count IS DISTINCT FROM reality.c
      OR counter.count IS NULL OR reality.c IS NULL;
  IF counter_drift <> 0 THEN
    DECLARE
      sample TEXT;
    BEGIN
      SELECT string_agg(coalesce(reality.status, counter.status) || '/shard' ||
               coalesce(reality.shard::text, counter.shard::text) || ':reality=' ||
               coalesce(reality.c::text,'NULL') || ' counter=' ||
               coalesce(counter.count::text,'NULL'), ', ')
        INTO sample
        FROM (
          SELECT status, mod(id,256)::smallint AS shard, COUNT(*)::bigint AS c
          FROM tickets GROUP BY 1,2
        ) AS reality
        FULL JOIN runtime_status_counts AS counter
          ON counter.entity_type='ticket' AND counter.status=reality.status AND counter.shard=reality.shard;
      RAISE EXCEPTION '041 validation: ticket counter drift (%): %', counter_drift, sample;
    END;
  END IF;

  -- Run counters untouched by this migration.
  SELECT COUNT(*) INTO run_counter_drift
    FROM t041_run_counter_baseline AS baseline
    FULL OUTER JOIN (
      SELECT status, shard, count
      FROM runtime_status_counts WHERE entity_type = 'run'
    ) AS counter
      ON counter.status = baseline.status
     AND counter.shard = baseline.shard
   WHERE counter.count IS DISTINCT FROM baseline.count
      OR counter.count IS NULL OR baseline.count IS NULL;
  IF run_counter_drift <> 0 THEN
    DECLARE
      rsample TEXT;
    BEGIN
      SELECT string_agg(coalesce(baseline.status, counter.status) || '/s' ||
               coalesce(baseline.shard::text, counter.shard::text) || ':base=' ||
               coalesce(baseline.count::text,'NULL') || ' now=' ||
               coalesce(counter.count::text,'NULL'), ', ')
        INTO rsample
        FROM t041_run_counter_baseline AS baseline
        FULL JOIN (
          SELECT status, shard, count FROM runtime_status_counts
          WHERE entity_type='run'
        ) AS counter ON counter.status=baseline.status AND counter.shard=baseline.shard
       WHERE counter.count IS DISTINCT FROM baseline.count
          OR counter.count IS NULL OR baseline.count IS NULL;
      RAISE EXCEPTION '041 validation: run counters disturbed (%): %', run_counter_drift, rsample;
    END;
  END IF;
END;
$block$;
