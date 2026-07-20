CREATE TABLE work_contexts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  status TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT work_contexts_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT work_contexts_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT work_contexts_revision_positive CHECK (revision > 0)
);

CREATE INDEX work_contexts_status_id_idx ON work_contexts (status, id);

CREATE TRIGGER work_contexts_revision_guard
BEFORE UPDATE ON work_contexts
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();
