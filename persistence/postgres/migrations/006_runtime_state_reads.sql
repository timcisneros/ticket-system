CREATE INDEX tickets_status_id_idx
  ON tickets (status, id);

CREATE INDEX runs_status_id_idx
  ON runs (status, id);

CREATE INDEX runs_ticket_id_idx
  ON runs (ticket_id, id);

CREATE INDEX events_run_position_idx
  ON events (run_id, position)
  WHERE run_id IS NOT NULL;

CREATE INDEX events_run_type_position_idx
  ON events (run_id, type, position)
  WHERE run_id IS NOT NULL;
