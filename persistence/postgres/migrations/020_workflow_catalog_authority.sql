CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_definitions_id_trimmed CHECK (length(btrim(id)) > 0 AND id = btrim(id)),
  CONSTRAINT workflow_definitions_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT workflow_definitions_revision_positive CHECK (revision > 0)
);

CREATE INDEX workflow_definitions_enabled_id_c_idx
  ON workflow_definitions (enabled, id COLLATE "C");

CREATE TRIGGER workflow_definitions_revision_guard
BEFORE UPDATE ON workflow_definitions
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

DO $migration_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tickets
    WHERE body->>'executionMode' = 'workflow'
       OR body->>'capabilityType' = 'workflow'
  ) THEN
    RAISE EXCEPTION '020_workflow_catalog_authority requires disposable PostgreSQL workflow-ticket data to be reset; no JSON importer or legacy compatibility path is provided';
  END IF;
END;
$migration_guard$;

ALTER TABLE tickets
  ADD COLUMN workflow_definition_id TEXT GENERATED ALWAYS AS (
    CASE
      WHEN body->>'executionMode' = 'workflow' OR body->>'capabilityType' = 'workflow'
      THEN NULLIF(btrim(body->>'workflowId'), '')
      ELSE NULL
    END
  ) STORED,
  ADD CONSTRAINT tickets_workflow_definition_fk
    FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions(id) ON DELETE RESTRICT;

CREATE INDEX tickets_workflow_definition_id_idx
  ON tickets (workflow_definition_id, id)
  WHERE workflow_definition_id IS NOT NULL;
