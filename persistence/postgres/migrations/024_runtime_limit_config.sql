-- Shared runtime policy values. max_active_runs and local_model_concurrency are
-- still enforced per process until deployment-wide coordination is cut over.
-- Current-format development boundary: no JSON importer or legacy branch.

CREATE TABLE runtime_limit_config (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  max_execution_steps BIGINT,
  max_model_requests_per_run BIGINT,
  max_workspace_operations_per_run BIGINT,
  max_runtime_duration_ms BIGINT,
  max_active_runs BIGINT,
  local_model_concurrency BIGINT,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT runtime_limit_config_singleton CHECK (id = 1),
  CONSTRAINT runtime_limit_config_values CHECK (
    (max_execution_steps IS NULL OR max_execution_steps >= 1) AND
    (max_model_requests_per_run IS NULL OR max_model_requests_per_run >= 1) AND
    (max_workspace_operations_per_run IS NULL OR max_workspace_operations_per_run >= 1) AND
    (max_runtime_duration_ms IS NULL OR max_runtime_duration_ms >= 5000) AND
    (max_active_runs IS NULL OR max_active_runs >= 1) AND
    (local_model_concurrency IS NULL OR local_model_concurrency >= 1)
  ),
  CONSTRAINT runtime_limit_config_revision_positive CHECK (revision > 0),
  CONSTRAINT runtime_limit_config_audit_shape CHECK (
    (updated_by IS NULL AND updated_at IS NULL) OR
    (updated_by IS NOT NULL AND length(btrim(updated_by)) > 0 AND updated_at IS NOT NULL)
  )
);

INSERT INTO runtime_limit_config (id) VALUES (1);

CREATE TRIGGER runtime_limit_config_revision_guard
BEFORE UPDATE ON runtime_limit_config
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();
