CREATE TABLE diagnostic_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  run_id BIGINT,
  ticket_id BIGINT,
  context_run_id BIGINT,
  context_ticket_id BIGINT REFERENCES tickets(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (length(btrim(type)) > 0),
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT diagnostic_logs_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT diagnostic_logs_context_run_ticket_fk FOREIGN KEY (context_run_id, context_ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT diagnostic_logs_scope_shape CHECK (
    (run_id IS NULL AND ticket_id IS NULL) OR
    (run_id IS NOT NULL AND ticket_id IS NOT NULL)
  ),
  CONSTRAINT diagnostic_logs_context_shape CHECK (
    context_run_id IS NULL OR context_ticket_id IS NOT NULL
  )
);

CREATE INDEX diagnostic_logs_run_id_desc_idx ON diagnostic_logs (run_id, id DESC)
  WHERE run_id IS NOT NULL;
CREATE INDEX diagnostic_logs_ticket_id_desc_idx ON diagnostic_logs (ticket_id, id DESC)
  WHERE ticket_id IS NOT NULL;
CREATE INDEX diagnostic_logs_context_run_id_desc_idx ON diagnostic_logs (context_run_id, id DESC)
  WHERE context_run_id IS NOT NULL;
CREATE INDEX diagnostic_logs_context_ticket_id_desc_idx ON diagnostic_logs (context_ticket_id, id DESC)
  WHERE context_ticket_id IS NOT NULL;
CREATE INDEX diagnostic_logs_type_id_desc_idx ON diagnostic_logs (type, id DESC);

CREATE FUNCTION reject_diagnostic_log_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'diagnostic logs are append-only';
END;
$function$;

CREATE TRIGGER diagnostic_logs_append_only
BEFORE UPDATE OR DELETE ON diagnostic_logs
FOR EACH ROW EXECUTE FUNCTION reject_diagnostic_log_mutation();
