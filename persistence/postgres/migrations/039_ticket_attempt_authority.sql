-- Kernel-owned Ticket-attempt authority.
--
-- This is lifecycle/admission authority only: immutable identity, exact Run
-- membership, and one topology-neutral disposition. Allocation plans and leaf
-- bindings are consulted below only to validate/backfill historical rows; new
-- admission never uses topology as attempt identity.

-- Refuse every historical shape that SQL can prove ambiguous. The migration
-- runner also executes the hash-aware JavaScript preflight before this file so
-- v2 plan, provenance, binding and aggregate hashes are validated by their
-- existing canonical normalizers.
DO $block$
BEGIN
  IF EXISTS (
    SELECT 1 FROM runs
    WHERE NULLIF(body->>'allocationPlanId', '') IS NOT NULL
      AND body->>'allocationPlanId' !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: a Run has a non-numeric allocationPlanId';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM runs AS run
    LEFT JOIN allocation_plans AS plan
      ON plan.id = (run.body->>'allocationPlanId')::bigint
    WHERE NULLIF(run.body->>'allocationPlanId', '') IS NOT NULL
      AND (plan.id IS NULL OR plan.ticket_id <> run.ticket_id)
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: a Run has a missing or cross-Ticket allocation plan';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM runs
    WHERE NULLIF(body->>'allocationPlanId', '') IS NOT NULL
    GROUP BY ticket_id, body->>'allocationPlanId'
    HAVING count(*) FILTER (WHERE NULLIF(body->>'ticketOpenedAt', '') IS NULL) > 0
       OR count(DISTINCT body->>'ticketOpenedAt') <> 1
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: an allocation plan was reused across admission waves';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM runs
    WHERE NULLIF(body->>'allocationPlanId', '') IS NULL
      AND NULLIF(body->>'ticketOpenedAt', '') IS NOT NULL
    GROUP BY ticket_id, body->>'ticketOpenedAt'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: a multi-Run non-plan wave has no authoritative membership identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM runs AS run
    LEFT JOIN run_consequences AS consequence ON consequence.run_id = run.id
    LEFT JOIN replay_snapshots AS replay ON replay.run_id = run.id
    WHERE run.status IN ('completed', 'failed', 'interrupted')
      AND (
        replay.finalized_at IS NULL OR
        NOT EXISTS (
          SELECT 1 FROM events AS event
          WHERE event.run_id = run.id AND event.type = 'run.terminalized'
        ) OR
        (
          run.body->'completionAuthoritySnapshot' IS NOT NULL AND
          run.body->'completionAuthoritySnapshot' <> 'null'::jsonb AND
          consequence.consequence->'completionDecision' IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: terminal Run evidence is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM allocation_plans AS plan
    JOIN runs AS run ON (run.body->>'allocationPlanId')::bigint = plan.id
    WHERE plan.body->>'version' = '2'
      AND (
        plan.body->'planningProvenance' IS NULL OR
        run.body->'leafRunBinding' IS NULL OR
        (run.body->'leafRunBinding'->>'runId')::bigint <> run.id OR
        (run.body->'leafRunBinding'->>'ticketId')::bigint <> run.ticket_id OR
        (run.body->'leafRunBinding'->>'allocationPlanId')::bigint <> plan.id
      )
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: historical v2 leaf binding is missing or contradictory';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM allocation_plans AS plan
    WHERE plan.body->>'version' = '2'
      AND EXISTS (
        SELECT 1 FROM runs AS run
        WHERE (run.body->>'allocationPlanId')::bigint = plan.id
      )
      AND (
        jsonb_array_length(plan.body->'items') <>
          (SELECT count(*) FROM runs AS run
           WHERE (run.body->>'allocationPlanId')::bigint = plan.id) OR
        EXISTS (
          SELECT 1
          FROM runs AS run
          WHERE (run.body->>'allocationPlanId')::bigint = plan.id
          GROUP BY run.body->'leafRunBinding'->>'allocationItemId'
          HAVING count(*) <> 1
        )
      )
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: historical v2 leaf-set membership is incomplete or duplicated';
  END IF;
END;
$block$;

CREATE TABLE ticket_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  ordinal BIGINT NOT NULL CHECK (ordinal > 0),
  member_count BIGINT NOT NULL CHECK (member_count > 0),
  disposition TEXT CHECK (disposition IN ('completed', 'failed', 'blocked', 'interrupted')),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  CONSTRAINT ticket_attempts_id_ticket_unique UNIQUE (id, ticket_id),
  CONSTRAINT ticket_attempts_ticket_ordinal_unique UNIQUE (ticket_id, ordinal),
  CONSTRAINT ticket_attempts_settlement_shape CHECK (
    (disposition IS NULL AND settled_at IS NULL) OR
    (disposition IS NOT NULL AND settled_at IS NOT NULL)
  )
);

-- This is the database-owned current-attempt invariant. A Ticket may have
-- arbitrarily many settled attempts but at most one whose disposition is not
-- yet authoritative.
CREATE UNIQUE INDEX ticket_attempts_one_unsettled_per_ticket
  ON ticket_attempts (ticket_id)
  WHERE disposition IS NULL;

ALTER TABLE runs ADD COLUMN ticket_attempt_id BIGINT;

CREATE TEMP TABLE ticket_attempt_backfill_members ON COMMIT DROP AS
SELECT
  run.id AS run_id,
  run.ticket_id,
  CASE
    WHEN NULLIF(run.body->>'allocationPlanId', '') IS NOT NULL
      THEN 'plan:' || (run.body->>'allocationPlanId')
    ELSE 'run:' || run.id::text
  END AS attempt_key,
  run.status,
  run.created_at,
  run.completed_at,
  CASE
    WHEN run.status NOT IN ('completed', 'failed', 'interrupted') THEN NULL
    WHEN run.body->'completionAuthoritySnapshot' IS NULL OR
         run.body->'completionAuthoritySnapshot' = 'null'::jsonb
      THEN CASE run.status
        WHEN 'completed' THEN 'completed'
        WHEN 'interrupted' THEN 'interrupted'
        ELSE 'failed'
      END
    WHEN consequence.consequence->'completionDecision'->>'completionDisposition' = 'completed'
      THEN 'completed'
    WHEN consequence.consequence->'completionDecision'->>'completionDisposition' = 'blocked'
      THEN 'blocked'
    WHEN run.status = 'interrupted' THEN 'interrupted'
    ELSE 'failed'
  END AS member_disposition
FROM runs AS run
LEFT JOIN run_consequences AS consequence ON consequence.run_id = run.id;

CREATE TEMP TABLE ticket_attempt_backfill_groups ON COMMIT DROP AS
WITH grouped AS (
  SELECT
    ticket_id,
    attempt_key,
    count(*)::bigint AS member_count,
    min(created_at) AS admitted_at,
    max(completed_at) AS completed_at,
    bool_and(status IN ('completed', 'failed', 'interrupted')) AS all_terminal,
    bool_or(member_disposition = 'blocked') AS any_blocked,
    bool_or(member_disposition = 'failed') AS any_failed,
    bool_or(member_disposition = 'interrupted') AS any_interrupted,
    min(run_id) AS first_run_id
  FROM ticket_attempt_backfill_members
  GROUP BY ticket_id, attempt_key
), ordered AS (
  SELECT
    grouped.*,
    row_number() OVER (
      PARTITION BY ticket_id ORDER BY admitted_at, first_run_id
    )::bigint AS ordinal
  FROM grouped
)
SELECT
  ordered.*,
  CASE
    WHEN NOT all_terminal THEN NULL
    WHEN any_blocked THEN 'blocked'
    WHEN any_failed THEN 'failed'
    WHEN any_interrupted THEN 'interrupted'
    ELSE 'completed'
  END AS disposition,
  CASE WHEN all_terminal THEN completed_at ELSE NULL END AS settled_at
FROM ordered;

-- A settled v2 attempt must already carry the old, hash-validated aggregate
-- proof, and its old topology result must agree with the generic disposition.
DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ticket_attempt_backfill_groups AS grouped
    JOIN ticket_attempt_backfill_members AS member
      ON member.ticket_id = grouped.ticket_id
     AND member.attempt_key = grouped.attempt_key
    JOIN runs AS run ON run.id = member.run_id
    JOIN allocation_plans AS plan
      ON plan.id = (run.body->>'allocationPlanId')::bigint
    WHERE grouped.disposition IS NOT NULL
      AND plan.body->>'version' = '2'
      AND (
        plan.body->'aggregateDecision' IS NULL OR
        plan.body->'aggregateDecision'->>'aggregateStatus' <>
          CASE
            WHEN grouped.disposition = 'completed' THEN 'completed'
            WHEN grouped.disposition = 'interrupted' THEN 'interrupted'
            ELSE 'failed'
          END
      )
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: historical v2 aggregate proof conflicts with generic disposition';
  END IF;

  IF EXISTS (
    SELECT ticket_id
    FROM ticket_attempt_backfill_groups
    WHERE disposition IS NULL
    GROUP BY ticket_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: a Ticket has overlapping unsettled historical attempts';
  END IF;
END;
$block$;

INSERT INTO ticket_attempts
  (ticket_id, ordinal, member_count, disposition, admitted_at, settled_at)
SELECT ticket_id, ordinal, member_count, disposition, admitted_at, settled_at
FROM ticket_attempt_backfill_groups
ORDER BY ticket_id, ordinal;

-- Filling a newly introduced kernel-owned foreign key is migration authority,
-- not a new Run revision. Advancing the Run revision would rewrite historical
-- evidence metadata, while leaving the pre-existing revision guard enabled
-- makes the one-column backfill impossible. Suspend only that guard for this
-- statement; all Run body/lifecycle/evidence columns and revision remain exact.
ALTER TABLE runs DISABLE TRIGGER runs_revision_guard;

UPDATE runs AS run
SET ticket_attempt_id = attempt.id
FROM ticket_attempt_backfill_members AS member
JOIN ticket_attempt_backfill_groups AS grouped
  ON grouped.ticket_id = member.ticket_id
 AND grouped.attempt_key = member.attempt_key
JOIN ticket_attempts AS attempt
  ON attempt.ticket_id = grouped.ticket_id
 AND attempt.ordinal = grouped.ordinal
WHERE run.id = member.run_id;

ALTER TABLE runs ENABLE TRIGGER runs_revision_guard;

DO $block$
DECLARE
  legacy_count BIGINT;
  attempt_count BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM runs WHERE ticket_attempt_id IS NULL) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: not every Run mapped exactly once';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM ticket_attempts AS attempt
    LEFT JOIN runs AS run ON run.ticket_attempt_id = attempt.id
    GROUP BY attempt.id, attempt.member_count
    HAVING count(run.id) <> attempt.member_count
  ) THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: backfilled membership count mismatch';
  END IF;
  SELECT count(DISTINCT ticket_id::text || ':' || CASE
    WHEN NULLIF(body->>'allocationPlanId', '') IS NOT NULL
      THEN 'plan:' || (body->>'allocationPlanId')
    ELSE 'run:' || id::text
  END) INTO legacy_count FROM runs;
  SELECT count(*) INTO attempt_count FROM ticket_attempts;
  IF legacy_count <> attempt_count THEN
    RAISE EXCEPTION '039_ticket_attempt_authority: attempt count drift (% versus %)',
      legacy_count, attempt_count;
  END IF;
END;
$block$;

ALTER TABLE runs ALTER COLUMN ticket_attempt_id SET NOT NULL;
ALTER TABLE runs
  ADD CONSTRAINT runs_ticket_attempt_ticket_fk
  FOREIGN KEY (ticket_attempt_id, ticket_id)
  REFERENCES ticket_attempts(id, ticket_id) ON DELETE RESTRICT;

CREATE INDEX runs_ticket_attempt_id_id_idx
  ON runs (ticket_attempt_id, id);

CREATE FUNCTION enforce_ticket_attempt_revision() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
  actual_members BIGINT;
  incomplete_members BIGINT;
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'ticket_attempts revision must advance exactly once';
  END IF;
  IF NEW.id <> OLD.id OR NEW.ticket_id <> OLD.ticket_id OR
     NEW.ordinal <> OLD.ordinal OR NEW.member_count <> OLD.member_count OR
     NEW.admitted_at <> OLD.admitted_at THEN
    RAISE EXCEPTION 'Ticket attempt identity and membership cardinality are immutable';
  END IF;
  IF OLD.disposition IS NOT NULL THEN
    RAISE EXCEPTION 'Ticket attempt disposition is write-once';
  END IF;
  IF NEW.disposition IS NULL THEN
    RAISE EXCEPTION 'Ticket attempt updates are reserved for terminal settlement';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'interrupted'))
    INTO actual_members, incomplete_members
  FROM runs WHERE ticket_attempt_id = OLD.id;
  IF actual_members <> OLD.member_count OR incomplete_members <> 0 THEN
    RAISE EXCEPTION 'Ticket attempt cannot settle before exact membership is terminal';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER ticket_attempts_revision_guard
BEFORE UPDATE ON ticket_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_ticket_attempt_revision();

CREATE FUNCTION enforce_run_ticket_attempt_membership() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
  attempt_ticket_id BIGINT;
  expected_members BIGINT;
  actual_members BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Run attempt membership is immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.ticket_attempt_id <> OLD.ticket_attempt_id THEN
      RAISE EXCEPTION 'Run attempt membership is immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT ticket_id, member_count
    INTO attempt_ticket_id, expected_members
  FROM ticket_attempts
  WHERE id = NEW.ticket_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt_ticket_id <> NEW.ticket_id THEN
    RAISE EXCEPTION 'Run and Ticket attempt must belong to the same Ticket';
  END IF;
  SELECT count(*) INTO actual_members
  FROM runs WHERE ticket_attempt_id = NEW.ticket_attempt_id;
  IF actual_members >= expected_members THEN
    RAISE EXCEPTION 'No Run may be appended after complete attempt admission';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER runs_ticket_attempt_membership_guard
BEFORE INSERT OR UPDATE OF ticket_attempt_id OR DELETE ON runs
FOR EACH ROW EXECUTE FUNCTION enforce_run_ticket_attempt_membership();

CREATE FUNCTION assert_ticket_attempt_membership_complete() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
  attempt_id BIGINT;
  expected_members BIGINT;
  actual_members BIGINT;
BEGIN
  -- This deferred constraint is attached only to the attempt INSERT. The
  -- complete Run set must therefore exist by transaction commit, while the
  -- BEFORE INSERT membership guard prevents any later append.
  attempt_id := NEW.id;
  SELECT member_count INTO expected_members
  FROM ticket_attempts WHERE id = attempt_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO actual_members
  FROM runs WHERE ticket_attempt_id = attempt_id;
  IF actual_members <> expected_members THEN
    RAISE EXCEPTION 'Ticket attempt membership count % does not equal admitted count %',
      actual_members, expected_members;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER ticket_attempt_membership_complete_from_attempt
AFTER INSERT ON ticket_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ticket_attempt_membership_complete();

COMMENT ON TABLE ticket_attempts IS
  'Internal kernel authority for one Ticket execution attempt: immutable Run membership and one topology-neutral disposition. Not a plan or product primitive.';
COMMENT ON COLUMN runs.ticket_attempt_id IS
  'Kernel-assigned immutable membership in exactly one same-Ticket execution attempt.';
