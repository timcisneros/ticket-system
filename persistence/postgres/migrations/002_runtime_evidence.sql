DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM events LIMIT 1) THEN
    RAISE EXCEPTION '002_runtime_evidence requires an empty development event store; reset disposable PostgreSQL foundation data';
  END IF;
END;
$block$;

ALTER TABLE events
  DROP CONSTRAINT events_payload_check;

ALTER TABLE events
  ALTER COLUMN payload TYPE JSON USING payload::json;

ALTER TABLE events
  ADD CONSTRAINT events_payload_object CHECK (json_typeof(payload) = 'object');

ALTER TABLE runs
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD CONSTRAINT runs_lifecycle_timestamps CHECK (
    (status = 'pending' AND completed_at IS NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL) OR
    (status IN ('completed', 'failed', 'interrupted') AND completed_at IS NOT NULL)
  );

CREATE FUNCTION enforce_runtime_entity_revision() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION '% revision must advance exactly once', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'runs' THEN
    IF NEW.ticket_id <> OLD.ticket_id OR
       NEW.agent_id <> OLD.agent_id OR
       NEW.execution_mode <> OLD.execution_mode THEN
      RAISE EXCEPTION 'run identity and execution mode are immutable';
    END IF;
    IF OLD.status IN ('completed', 'failed', 'interrupted') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'terminal runs cannot be reopened';
    END IF;
    IF OLD.status = 'pending' AND NEW.status = 'completed' THEN
      RAISE EXCEPTION 'pending runs cannot complete without entering running';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER tickets_revision_guard
BEFORE UPDATE ON tickets
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TRIGGER runs_revision_guard
BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TABLE run_evaluations (
  run_id BIGINT PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  evaluation JSONB NOT NULL CHECK (jsonb_typeof(evaluation) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_evaluations_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT
);

CREATE TABLE run_consequences (
  run_id BIGINT PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  consequence JSONB NOT NULL CHECK (jsonb_typeof(consequence) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_consequences_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT
);

CREATE TABLE replay_snapshots (
  run_id BIGINT PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT replay_snapshots_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT
);

CREATE TABLE operation_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    length(btrim(idempotency_key)) > 0 AND length(idempotency_key) <= 512
  ),
  step_id TEXT,
  operation TEXT NOT NULL CHECK (length(btrim(operation)) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'refused')),
  target_id TEXT,
  target_kind TEXT,
  target_path TEXT,
  target_resource_id TEXT,
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operation_receipts_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT operation_receipts_idempotency_unique UNIQUE (run_id, idempotency_key)
);

CREATE INDEX operation_receipts_run_id_idx ON operation_receipts (run_id, id);
CREATE INDEX operation_receipts_ticket_id_idx ON operation_receipts (ticket_id, id);
CREATE INDEX operation_receipts_target_path_idx ON operation_receipts (target_id, target_path, id);

CREATE FUNCTION assert_terminal_run(target_run_id BIGINT) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  run_status TEXT;
BEGIN
  SELECT status INTO run_status FROM runs WHERE id = target_run_id;
  IF run_status IS NULL THEN
    RAISE EXCEPTION 'run % does not exist', target_run_id;
  END IF;
  IF run_status NOT IN ('completed', 'failed', 'interrupted') THEN
    RAISE EXCEPTION 'run % is not terminal', target_run_id;
  END IF;
END;
$function$;

CREATE FUNCTION require_terminal_run_evidence() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM assert_terminal_run(NEW.run_id);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER run_evaluations_terminal_guard
BEFORE INSERT ON run_evaluations
FOR EACH ROW EXECUTE FUNCTION require_terminal_run_evidence();

CREATE TRIGGER run_consequences_terminal_guard
BEFORE INSERT ON run_consequences
FOR EACH ROW EXECUTE FUNCTION require_terminal_run_evidence();

CREATE FUNCTION reject_append_only_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$function$;

CREATE TRIGGER run_evaluations_append_only
BEFORE UPDATE OR DELETE ON run_evaluations
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();

CREATE TRIGGER run_consequences_append_only
BEFORE UPDATE OR DELETE ON run_consequences
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();

CREATE TRIGGER operation_receipts_append_only
BEFORE UPDATE OR DELETE ON operation_receipts
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();

CREATE FUNCTION enforce_replay_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'replay snapshots cannot be deleted';
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized replay snapshots are immutable';
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.ticket_id <> OLD.ticket_id THEN
    RAISE EXCEPTION 'replay snapshot ownership is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'replay snapshot revision must advance exactly once';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION require_terminal_replay_finalization() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.finalized_at IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM assert_terminal_run(NEW.run_id);
    ELSIF OLD.finalized_at IS NULL THEN
      PERFORM assert_terminal_run(NEW.run_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER replay_snapshots_terminal_guard
BEFORE INSERT OR UPDATE ON replay_snapshots
FOR EACH ROW EXECUTE FUNCTION require_terminal_replay_finalization();

CREATE TRIGGER replay_snapshots_mutation_guard
BEFORE UPDATE OR DELETE ON replay_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_replay_snapshot_mutation();
