CREATE INDEX tickets_updated_id_idx
  ON tickets (updated_at DESC, id ASC);

CREATE INDEX tickets_work_context_status_updated_id_idx
  ON tickets ((body->>'workContextId'), status, updated_at DESC, id ASC);

CREATE INDEX runs_ticket_status_updated_id_idx
  ON runs (ticket_id, status, updated_at DESC, id DESC);

CREATE INDEX target_operation_intents_ticket_id_idx
  ON target_operation_intents (ticket_id, id);
