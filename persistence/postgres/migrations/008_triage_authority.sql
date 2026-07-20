CREATE INDEX tickets_unresolved_triage_id_idx
  ON tickets (id)
  WHERE body->'triage'->>'required' = 'true'
    AND NULLIF(body->'triage'->>'resolvedAt', '') IS NULL;

CREATE INDEX runs_unresolved_triage_id_idx
  ON runs (id)
  WHERE body->'triage'->>'required' = 'true'
    AND NULLIF(body->'triage'->>'resolvedAt', '') IS NULL;
