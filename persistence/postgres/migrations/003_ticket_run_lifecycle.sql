CREATE UNIQUE INDEX tickets_spawn_idempotency_idx
  ON tickets ((body->>'spawnIdempotencyKey'))
  WHERE body ? 'spawnIdempotencyKey' AND length(btrim(body->>'spawnIdempotencyKey')) > 0;

CREATE INDEX runs_ticket_batch_idx
  ON runs (ticket_id, (body->>'ticketOpenedAt'), id);
