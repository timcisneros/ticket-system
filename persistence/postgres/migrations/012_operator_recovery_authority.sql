ALTER TABLE operation_receipts
  ADD CONSTRAINT operation_receipts_identity_owner_unique UNIQUE (id, run_id, ticket_id);

CREATE TABLE operator_recovery_intents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_operation_receipt_id BIGINT NOT NULL,
  run_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  recovery_key TEXT NOT NULL CHECK (
    length(btrim(recovery_key)) > 0 AND length(recovery_key) <= 512
  ),
  requested_by TEXT NOT NULL CHECK (length(btrim(requested_by)) > 0),
  operation TEXT NOT NULL CHECK (operation IN ('writeFile', 'renamePath', 'deletePath')),
  target_id TEXT NOT NULL CHECK (length(btrim(target_id)) > 0),
  target_kind TEXT,
  target_path TEXT NOT NULL CHECK (length(btrim(target_path)) > 0),
  target_resource_id TEXT,
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operator_recovery_intents_original_owner_fk
    FOREIGN KEY (original_operation_receipt_id, run_id, ticket_id)
    REFERENCES operation_receipts(id, run_id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT operator_recovery_intents_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT operator_recovery_intents_original_unique UNIQUE (original_operation_receipt_id),
  CONSTRAINT operator_recovery_intents_recovery_key_unique UNIQUE (run_id, recovery_key)
);

CREATE INDEX operator_recovery_intents_run_id_idx
  ON operator_recovery_intents (run_id, id);

CREATE INDEX operator_recovery_intents_target_path_idx
  ON operator_recovery_intents (target_id, target_path, id);

CREATE TRIGGER operator_recovery_intents_append_only
BEFORE UPDATE OR DELETE ON operator_recovery_intents
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();
