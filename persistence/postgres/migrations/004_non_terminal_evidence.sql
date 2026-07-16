CREATE TABLE target_operation_intents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  operation_key TEXT NOT NULL CHECK (
    length(btrim(operation_key)) > 0 AND length(operation_key) <= 512
  ),
  step_id TEXT,
  operation TEXT NOT NULL CHECK (length(btrim(operation)) > 0),
  target_id TEXT,
  target_kind TEXT,
  target_path TEXT,
  target_resource_id TEXT,
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT target_operation_intents_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT target_operation_intents_operation_key_unique UNIQUE (run_id, operation_key)
);

CREATE INDEX target_operation_intents_run_id_idx
  ON target_operation_intents (run_id, id);

CREATE INDEX target_operation_intents_target_path_idx
  ON target_operation_intents (target_id, target_path, id);

CREATE INDEX events_run_evidence_key_idx
  ON events (run_id, (payload->>'evidenceKey'))
  WHERE payload->>'evidenceKey' IS NOT NULL;

CREATE TRIGGER target_operation_intents_append_only
BEFORE UPDATE OR DELETE ON target_operation_intents
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();
