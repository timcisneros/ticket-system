-- T3 activation baseline — objective-revision revision-1 authority for every
-- pre-T3 Ticket.
--
-- SEMANTIC SUMMARY (frozen T3 contract):
--   The JavaScript hook executed immediately before this file, inside the SAME
--   migration transaction, appended one `ticket.objective_revised` event per
--   eligible Ticket storing FULL canonical requested-outcome content
--   {objective, acceptanceCriteria} with a binding contentHash, provenance
--   `t3_activation_baseline`, migration actor, real append position and
--   activation-time capturedAt — a present-day activation fact, never
--   retroactive creation history. It installed the matching
--   body.objectiveRevision projection pointer ATOMICALLY with each event,
--   refused noncanonical legacy content, refused any pre-existing pointer or
--   event ambiguity, preserved generic tickets.revision via a narrowly scoped
--   tickets_revision_guard suspension (039 mechanism precedent — baseline
--   installation is migration materialization of pre-existing content, not an
--   operator-visible Ticket revision), and left zero partial state on failure.
--
-- ACTIVATION / CUTOVER BOUNDARY (repository-owned operational guidance):
--   1. quiesce the runtime and ALL Ticket-creation/writer paths;
--   2. prove quiescence (no runtime process, product port closed);
--   3. apply migrations through 042 via the canonical runner (pnpm db:migrate);
--   4. verify every Ticket carries coherent baseline event + pointer;
--   5. start the exact published revision-aware runtime source;
--   6. verify admission integrity enforcement and revision-1 creation;
--   7. reopen normal activity.
--   There must be NO interval where un-revisioned Tickets can be created after
--   the baseline exists, and NO interval where admission requires pointers
--   before baselines exist.
--
-- THIS FILE asserts convergence/coherence AFTER the hook and pins the exact
-- source identities of the hook and its normalization/hashing authority, so
-- no semantic source can silently redefine what "activation baseline" means.

DO $block$
DECLARE
  mismatch TEXT;
BEGIN
  SELECT string_agg(identity.label || '=' || identity.actual_sha256, ', ')
    INTO mismatch
    FROM t042_identity AS identity
   WHERE NOT EXISTS (
     SELECT 1 FROM (VALUES
       ('t042-objective-revision-baseline.js', 'cdf8d219542f84e4bd5fb6f9372d733e0d92fe325aacbbca01f37a648bafe797'),
       ('ticket-objective-revision-contract.js', '4e00d4b58e8a2a9d5086f8f0ce933e7237a520961d8fd07a048f02e187569205'),
       ('declared-work-contract.js', '50e0d6e1ed37a029b1606ef89a45c1738430bafb09b7eaffcdcdac515ef0674c')
     ) AS expected(label, sha256)
      WHERE expected.label = identity.label
        AND expected.sha256 = identity.actual_sha256
   );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION '042 source identity drift: %', mismatch;
  END IF;
  IF (SELECT COUNT(*) FROM t042_identity) <> 3 THEN
    RAISE EXCEPTION '042 identity table incomplete';
  END IF;
END;
$block$;

-- Convergence/coherence assertions over the completed baseline.
DO $block$
DECLARE
  tickets_without_pointer BIGINT;
  pointers_without_chain BIGINT;
  head_mismatches BIGINT;
  contiguity_violations BIGINT;
  provenance_violations BIGINT;
  disabled_guards BIGINT;
BEGIN
  -- UNCONDITIONAL every-Ticket invariant: after successful 042, EVERY Ticket
  -- carries coherent objective-revision authority. The hook refuses
  -- activation (T042_OBJECTIVE_REVISION_BASELINE_REQUIRED) on any Ticket that
  -- cannot truthfully receive it — e.g. objective-less legacy rows — before
  -- any mutation, so no skip class exists here.
  SELECT count(*) INTO tickets_without_pointer
    FROM tickets
   WHERE body->'objectiveRevision' IS NULL
      OR body->'objectiveRevision'->>'number' IS NULL
      OR body->'objectiveRevision'->>'hash' IS NULL;
  IF tickets_without_pointer <> 0 THEN
    RAISE EXCEPTION '042 baseline incomplete: % ticket(s) lack a projection pointer',
      tickets_without_pointer;
  END IF;

  SELECT count(*) INTO pointers_without_chain
    FROM tickets t
   WHERE NOT EXISTS (
     SELECT 1 FROM events e
      WHERE e.ticket_id = t.id AND e.type = 'ticket.objective_revised'
   );
  IF pointers_without_chain <> 0 THEN
    RAISE EXCEPTION '042 baseline incomplete: % pointer(s) without an event chain',
      pointers_without_chain;
  END IF;

  SELECT count(*) INTO head_mismatches
    FROM tickets t
    JOIN LATERAL (
      SELECT payload FROM events e
       WHERE e.ticket_id = t.id AND e.type = 'ticket.objective_revised'
       ORDER BY position DESC LIMIT 1
    ) head ON TRUE
   WHERE (head.payload->>'number')::bigint <> (t.body->'objectiveRevision'->>'number')::bigint
      OR head.payload->>'contentHash' <> t.body->'objectiveRevision'->>'hash';
  IF head_mismatches <> 0 THEN
    RAISE EXCEPTION '042 baseline incoherent: % pointer/head mismatches', head_mismatches;
  END IF;

  SELECT count(*) INTO contiguity_violations
    FROM (
      SELECT e.ticket_id, count(*) AS n, max((e.payload->>'number')::bigint) AS head_number
        FROM events e
       WHERE e.type = 'ticket.objective_revised'
       GROUP BY e.ticket_id
    ) chain
    JOIN tickets t ON t.id = chain.ticket_id
   WHERE chain.n <> chain.head_number
      OR chain.head_number <> (t.body->'objectiveRevision'->>'number')::bigint;
  IF contiguity_violations <> 0 THEN
    RAISE EXCEPTION '042 baseline incoherent: % chains violate contiguity from 1',
      contiguity_violations;
  END IF;

  SELECT count(*) INTO provenance_violations
    FROM events e
   WHERE e.type = 'ticket.objective_revised'
     AND e.payload->>'provenance' NOT IN ('creation', 't3_activation_baseline', 'revision');
  IF provenance_violations <> 0 THEN
    RAISE EXCEPTION '042 baseline incoherent: % events carry unknown provenance',
      provenance_violations;
  END IF;

  SELECT count(*) INTO disabled_guards
    FROM pg_trigger
   WHERE tgname = 'tickets_revision_guard'
     AND tgrelid = 'tickets'::regclass
     AND tgenabled <> 'O';
  IF disabled_guards <> 0 THEN
    RAISE EXCEPTION '042 baseline left tickets_revision_guard disabled';
  END IF;
END;
$block$;
