-- Local/mock connector fixture objects are structured runtime state. Keeping
-- them beside connector authority and receipts removes the final active JSON
-- catalog read from the server. No development JSON data is imported.

CREATE TABLE local_connector_objects (
  id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
  work_context_id BIGINT NOT NULL REFERENCES work_contexts(id) ON DELETE RESTRICT,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER local_connector_objects_revision_guard
BEFORE UPDATE ON local_connector_objects
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE INDEX local_connector_objects_work_context_id_id_idx
  ON local_connector_objects (work_context_id, id);
