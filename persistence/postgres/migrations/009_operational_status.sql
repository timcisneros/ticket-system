CREATE TABLE runtime_status_counts (
  entity_type TEXT NOT NULL,
  status TEXT NOT NULL,
  shard SMALLINT NOT NULL,
  count BIGINT NOT NULL,
  CONSTRAINT runtime_status_counts_primary_key PRIMARY KEY (entity_type, status, shard),
  CONSTRAINT runtime_status_counts_identity CHECK (
    shard >= 0 AND shard < 256 AND (
      (entity_type = 'ticket' AND status IN ('open', 'in_progress', 'completed', 'failed', 'blocked', 'closed')) OR
      (entity_type = 'run' AND status IN ('pending', 'running', 'completed', 'failed', 'interrupted'))
    )
  ),
  CONSTRAINT runtime_status_counts_nonnegative CHECK (count >= 0)
);

-- Prevent a write from landing between the initial projection and trigger installation.
-- The cutover server will not start against a partially migrated schema, but the lock also
-- makes this migration correct if an older development process is still connected.
LOCK TABLE tickets, runs IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO runtime_status_counts (entity_type, status, shard, count)
SELECT 'ticket', status, mod(id, 256)::smallint, COUNT(*)::bigint
FROM tickets
GROUP BY status, mod(id, 256)
UNION ALL
SELECT 'run', status, mod(id, 256)::smallint, COUNT(*)::bigint
FROM runs
GROUP BY status, mod(id, 256);

CREATE FUNCTION maintain_runtime_status_count() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  entity_kind TEXT := TG_ARGV[0];
  prior_shard SMALLINT;
  next_shard SMALLINT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status AND OLD.id = NEW.id THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    prior_shard := mod(OLD.id, 256)::smallint;
    UPDATE runtime_status_counts
    SET count = count - 1
    WHERE entity_type = entity_kind AND status = OLD.status AND shard = prior_shard;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing runtime status count for % status % shard %', entity_kind, OLD.status, prior_shard;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    next_shard := mod(NEW.id, 256)::smallint;
    INSERT INTO runtime_status_counts (entity_type, status, shard, count)
    VALUES (entity_kind, NEW.status, next_shard, 1)
    ON CONFLICT (entity_type, status, shard)
    DO UPDATE SET count = runtime_status_counts.count + 1;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER tickets_runtime_status_count
AFTER INSERT OR DELETE OR UPDATE OF status ON tickets
FOR EACH ROW EXECUTE FUNCTION maintain_runtime_status_count('ticket');

CREATE TRIGGER runs_runtime_status_count
AFTER INSERT OR DELETE OR UPDATE OF status ON runs
FOR EACH ROW EXECUTE FUNCTION maintain_runtime_status_count('run');

CREATE INDEX runs_running_lease_expiry_id_idx
  ON runs (lease_expires_at NULLS FIRST, id)
  WHERE status = 'running';
