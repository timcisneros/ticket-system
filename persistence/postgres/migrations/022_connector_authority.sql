-- Connector definitions and receipts are a current-format authority boundary.
-- Local mock connector objects are added to PostgreSQL by migration 026; no JSON importer or legacy branch is provided.

CREATE TABLE connectors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  work_context_id BIGINT NOT NULL,
  credential_ref TEXT,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT connectors_name_trimmed CHECK (length(btrim(name)) > 0),
  CONSTRAINT connectors_status_check CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT connectors_kind_check CHECK (kind = 'local_mock'),
  CONSTRAINT connectors_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT connectors_revision_positive CHECK (revision > 0),
  CONSTRAINT connectors_work_context_fk
    FOREIGN KEY (work_context_id) REFERENCES work_contexts(id) ON DELETE RESTRICT,
  CONSTRAINT connectors_identity_work_context_unique UNIQUE (id, work_context_id)
);

CREATE INDEX connectors_status_id_idx ON connectors (status, id);
CREATE INDEX connectors_work_context_status_id_idx ON connectors (work_context_id, status, id);

CREATE TRIGGER connectors_revision_guard
BEFORE UPDATE ON connectors
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TABLE connector_status_counts (
  status TEXT NOT NULL,
  shard SMALLINT NOT NULL,
  count BIGINT NOT NULL,
  CONSTRAINT connector_status_counts_primary_key PRIMARY KEY (status, shard),
  CONSTRAINT connector_status_counts_identity CHECK (
    status IN ('active', 'paused', 'archived') AND shard >= 0 AND shard < 256
  ),
  CONSTRAINT connector_status_counts_nonnegative CHECK (count >= 0)
);

-- Keep exact operational counts fixed-work without serializing all connector writes on one row.
LOCK TABLE connectors IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO connector_status_counts (status, shard, count)
SELECT status, mod(id, 256)::smallint, COUNT(*)::bigint
FROM connectors
GROUP BY status, mod(id, 256);

CREATE FUNCTION maintain_connector_status_count() RETURNS trigger
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
    UPDATE connector_status_counts
    SET count = count - 1
    WHERE status = OLD.status AND shard = prior_shard;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing connector status count for status % shard %', OLD.status, prior_shard;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    next_shard := mod(NEW.id, 256)::smallint;
    INSERT INTO connector_status_counts (status, shard, count)
    VALUES (NEW.status, next_shard, 1)
    ON CONFLICT (status, shard)
    DO UPDATE SET count = connector_status_counts.count + 1;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER connectors_status_count
AFTER INSERT OR DELETE OR UPDATE OF status ON connectors
FOR EACH ROW EXECUTE FUNCTION maintain_connector_status_count();

CREATE TABLE connector_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connector_id BIGINT NOT NULL,
  work_context_id BIGINT NOT NULL,
  operation TEXT NOT NULL,
  result_status TEXT NOT NULL,
  body JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT connector_receipts_operation_check
    CHECK (operation IN ('read', 'read_refused', 'write_refused')),
  CONSTRAINT connector_receipts_result_status_check
    CHECK (result_status IN ('ok', 'failed', 'refused')),
  CONSTRAINT connector_receipts_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT connector_receipts_connector_context_fk
    FOREIGN KEY (connector_id, work_context_id)
    REFERENCES connectors(id, work_context_id) ON DELETE RESTRICT
);

CREATE INDEX connector_receipts_connector_id_desc_idx
  ON connector_receipts (connector_id, id DESC);
CREATE INDEX connector_receipts_operation_id_desc_idx
  ON connector_receipts (operation, id DESC);
CREATE INDEX connector_receipts_refusal_id_desc_idx
  ON connector_receipts (id DESC)
  WHERE operation IN ('read_refused', 'write_refused') OR result_status = 'failed';

CREATE TRIGGER connector_receipts_append_only
BEFORE UPDATE OR DELETE ON connector_receipts
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();
