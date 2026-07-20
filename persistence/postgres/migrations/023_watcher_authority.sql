-- Bounded manual watcher definitions, append-only observations, and ticket proposals.
-- This is a current-format development boundary; no JSON importer or legacy branch is provided.

CREATE TABLE watchers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  work_context_id BIGINT NOT NULL,
  source_kind TEXT NOT NULL,
  last_observed_at TIMESTAMPTZ,
  last_observation_hash TEXT,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT watchers_name_trimmed CHECK (length(btrim(name)) > 0),
  CONSTRAINT watchers_status_check CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT watchers_source_kind_check CHECK (source_kind = 'workspace_file'),
  CONSTRAINT watchers_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT watchers_revision_positive CHECK (revision > 0),
  CONSTRAINT watchers_work_context_fk
    FOREIGN KEY (work_context_id) REFERENCES work_contexts(id) ON DELETE RESTRICT,
  CONSTRAINT watchers_identity_work_context_unique UNIQUE (id, work_context_id)
);

CREATE INDEX watchers_status_id_idx ON watchers (status, id);
CREATE INDEX watchers_work_context_status_id_idx ON watchers (work_context_id, status, id);

CREATE TRIGGER watchers_revision_guard
BEFORE UPDATE ON watchers
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TABLE watcher_status_counts (
  status TEXT NOT NULL,
  shard SMALLINT NOT NULL,
  count BIGINT NOT NULL,
  CONSTRAINT watcher_status_counts_primary_key PRIMARY KEY (status, shard),
  CONSTRAINT watcher_status_counts_identity CHECK (
    status IN ('active', 'paused', 'archived') AND shard >= 0 AND shard < 256
  ),
  CONSTRAINT watcher_status_counts_nonnegative CHECK (count >= 0)
);

LOCK TABLE watchers IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO watcher_status_counts (status, shard, count)
SELECT status, mod(id, 256)::smallint, COUNT(*)::bigint
FROM watchers
GROUP BY status, mod(id, 256);

CREATE FUNCTION maintain_watcher_status_count() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  prior_shard SMALLINT;
  next_shard SMALLINT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status AND OLD.id = NEW.id THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    prior_shard := mod(OLD.id, 256)::smallint;
    UPDATE watcher_status_counts
    SET count = count - 1
    WHERE status = OLD.status AND shard = prior_shard;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing watcher status count for status % shard %', OLD.status, prior_shard;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    next_shard := mod(NEW.id, 256)::smallint;
    INSERT INTO watcher_status_counts (status, shard, count)
    VALUES (NEW.status, next_shard, 1)
    ON CONFLICT (status, shard)
    DO UPDATE SET count = watcher_status_counts.count + 1;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER watchers_status_count
AFTER INSERT OR DELETE OR UPDATE OF status ON watchers
FOR EACH ROW EXECUTE FUNCTION maintain_watcher_status_count();

CREATE TABLE watcher_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  watcher_id BIGINT NOT NULL,
  work_context_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  previous_hash TEXT,
  current_hash TEXT,
  body JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT watcher_observations_status_check
    CHECK (status IN ('changed', 'unchanged', 'failed', 'refused')),
  CONSTRAINT watcher_observations_hash_shape CHECK (
    (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$') AND
    (current_hash IS NULL OR current_hash ~ '^[a-f0-9]{64}$') AND
    (status NOT IN ('changed', 'unchanged') OR current_hash IS NOT NULL)
  ),
  CONSTRAINT watcher_observations_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT watcher_observations_watcher_context_fk
    FOREIGN KEY (watcher_id, work_context_id)
    REFERENCES watchers(id, work_context_id) ON DELETE RESTRICT,
  CONSTRAINT watcher_observations_identity_unique UNIQUE (id, watcher_id, work_context_id)
);

CREATE INDEX watcher_observations_watcher_id_desc_idx
  ON watcher_observations (watcher_id, id DESC);
CREATE INDEX watcher_observations_failure_id_desc_idx
  ON watcher_observations (id DESC) WHERE status IN ('failed', 'refused');

CREATE TRIGGER watcher_observations_append_only
BEFORE UPDATE OR DELETE ON watcher_observations
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();

CREATE TABLE watcher_ticket_proposals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  watcher_id BIGINT NOT NULL,
  work_context_id BIGINT NOT NULL,
  observation_id BIGINT,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  created_ticket_id BIGINT,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  body JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT watcher_ticket_proposals_status_check
    CHECK (status IN ('proposed', 'approved', 'rejected')),
  CONSTRAINT watcher_ticket_proposals_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT watcher_ticket_proposals_revision_positive CHECK (revision > 0),
  CONSTRAINT watcher_ticket_proposals_disposition_shape CHECK (
    (status = 'proposed' AND created_ticket_id IS NULL AND approved_at IS NULL AND rejected_at IS NULL) OR
    (status = 'approved' AND created_ticket_id IS NOT NULL AND approved_at IS NOT NULL AND rejected_at IS NULL) OR
    (status = 'rejected' AND created_ticket_id IS NULL AND approved_at IS NULL AND rejected_at IS NOT NULL)
  ),
  CONSTRAINT watcher_ticket_proposals_watcher_context_fk
    FOREIGN KEY (watcher_id, work_context_id)
    REFERENCES watchers(id, work_context_id) ON DELETE RESTRICT,
  CONSTRAINT watcher_ticket_proposals_observation_context_fk
    FOREIGN KEY (observation_id, watcher_id, work_context_id)
    REFERENCES watcher_observations(id, watcher_id, work_context_id) ON DELETE RESTRICT,
  CONSTRAINT watcher_ticket_proposals_created_ticket_fk
    FOREIGN KEY (created_ticket_id) REFERENCES tickets(id) ON DELETE RESTRICT,
  CONSTRAINT watcher_ticket_proposals_identity_unique UNIQUE (id, watcher_id, work_context_id)
);

CREATE INDEX watcher_ticket_proposals_watcher_id_desc_idx
  ON watcher_ticket_proposals (watcher_id, id DESC);
CREATE INDEX watcher_ticket_proposals_status_id_desc_idx
  ON watcher_ticket_proposals (status, id DESC);

CREATE TRIGGER watcher_ticket_proposals_revision_guard
BEFORE UPDATE ON watcher_ticket_proposals
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tickets WHERE body #>> '{source,type}' = 'watcher_proposal') THEN
    RAISE EXCEPTION '023_watcher_authority requires disposable PostgreSQL watcher-ticket data to be reset; no JSON importer or legacy compatibility path is provided';
  END IF;
END $$;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_watcher_proposal_body_shape CHECK (
    body #>> '{source,type}' IS DISTINCT FROM 'watcher_proposal' OR (
      jsonb_typeof(body #> '{source,proposalId}') = 'number' AND
      jsonb_typeof(body #> '{source,watcherId}') = 'number' AND
      jsonb_typeof(body #> '{source,workContextId}') = 'number' AND
      (body #>> '{source,proposalId}') ~ '^[1-9][0-9]*$' AND
      (body #>> '{source,watcherId}') ~ '^[1-9][0-9]*$' AND
      (body #>> '{source,workContextId}') ~ '^[1-9][0-9]*$' AND
      body->>'workContextId' = body #>> '{source,workContextId}'
    )
  ),
  ADD COLUMN watcher_proposal_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN body #>> '{source,type}' = 'watcher_proposal'
      THEN (body #>> '{source,proposalId}')::BIGINT ELSE NULL END
  ) STORED,
  ADD COLUMN watcher_source_watcher_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN body #>> '{source,type}' = 'watcher_proposal'
      THEN (body #>> '{source,watcherId}')::BIGINT ELSE NULL END
  ) STORED,
  ADD COLUMN watcher_source_work_context_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN body #>> '{source,type}' = 'watcher_proposal'
      THEN (body #>> '{source,workContextId}')::BIGINT ELSE NULL END
  ) STORED,
  ADD CONSTRAINT tickets_watcher_proposal_fk
    FOREIGN KEY (watcher_proposal_id, watcher_source_watcher_id, watcher_source_work_context_id)
    REFERENCES watcher_ticket_proposals(id, watcher_id, work_context_id)
    ON DELETE RESTRICT;

CREATE INDEX tickets_watcher_proposal_id_idx ON tickets (watcher_proposal_id, id)
  WHERE watcher_proposal_id IS NOT NULL;
