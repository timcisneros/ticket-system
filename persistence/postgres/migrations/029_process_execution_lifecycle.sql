-- Durable, idempotent authority for bounded process execution. The immutable
-- launch plan is committed before the native launcher is contacted. Lifecycle
-- fields are the only mutable projection; authority cannot be rewritten.

CREATE TABLE process_operations (
  operation_identity TEXT PRIMARY KEY CHECK (
    operation_identity ~ '^process-operation:[0-9a-f]{64}$'
  ),
  run_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  acting_agent_id BIGINT NOT NULL REFERENCES configured_agents(id) ON DELETE RESTRICT,
  step_id TEXT,
  runtime_phase TEXT NOT NULL CHECK (
    runtime_phase IN ('inspection', 'mutation', 'verification')
  ),
  target_id TEXT NOT NULL CHECK (
    target_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  profile_id TEXT NOT NULL CHECK (
    profile_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  policy_snapshot_hash TEXT NOT NULL CHECK (
    policy_snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  runtime_capability_generation TEXT NOT NULL CHECK (
    runtime_capability_generation ~ '^process-runtime-v1-[0-9a-f]{64}$'
  ),
  launch_plan_version INTEGER NOT NULL CHECK (launch_plan_version = 1),
  launch_plan_hash TEXT NOT NULL CHECK (launch_plan_hash ~ '^[0-9a-f]{64}$'),
  launch_plan JSONB NOT NULL CHECK (jsonb_typeof(launch_plan) = 'object'),
  workspace_snapshot_id TEXT NOT NULL CHECK (
    length(workspace_snapshot_id) BETWEEN 1 AND 128
  ),
  workspace_manifest_hash TEXT NOT NULL CHECK (
    workspace_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  materializer_generation TEXT NOT NULL CHECK (
    length(materializer_generation) BETWEEN 1 AND 128
  ),
  containment_generation_id TEXT NOT NULL CHECK (
    containment_generation_id ~ '^sandbox-containment-v1-[0-9a-f]{64}$'
  ),
  rootfs_id TEXT NOT NULL CHECK (
    rootfs_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  rootfs_manifest_hash TEXT NOT NULL CHECK (
    rootfs_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  executable_identity_hash TEXT NOT NULL CHECK (
    executable_identity_hash ~ '^[0-9a-f]{64}$'
  ),
  execution_policy_hash TEXT NOT NULL CHECK (
    execution_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  filesystem_policy_hash TEXT NOT NULL CHECK (
    filesystem_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  lifecycle_state TEXT NOT NULL DEFAULT 'intent' CHECK (
    lifecycle_state IN ('intent', 'active', 'finalizing', 'terminal')
  ),
  launcher_acceptance_identity TEXT CHECK (
    launcher_acceptance_identity IS NULL OR
    launcher_acceptance_identity ~ '^process-launcher-acceptance:[0-9a-f]{64}$'
  ),
  dispatch_claim_owner TEXT CHECK (
    dispatch_claim_owner IS NULL OR
    (length(btrim(dispatch_claim_owner)) BETWEEN 1 AND 256)
  ),
  dispatch_claim_expires_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN (
      'completed',
      'failed_to_start',
      'exited_nonzero',
      'signaled',
      'timed_out',
      'cancelled',
      'output_limit_exceeded',
      'resource_limit_exceeded',
      'policy_denied',
      'runtime_interrupted'
    )
  ),
  terminal_result JSONB CHECK (
    terminal_result IS NULL OR jsonb_typeof(terminal_result) = 'object'
  ),
  terminal_result_hash TEXT CHECK (
    terminal_result_hash IS NULL OR terminal_result_hash ~ '^[0-9a-f]{64}$'
  ),
  exit_code INTEGER,
  terminating_signal INTEGER,
  resource_cause TEXT CHECK (
    resource_cause IS NULL OR resource_cause IN (
      'memory', 'process_count', 'open_files', 'file_size', 'temporary_storage'
    )
  ),
  stdout_byte_count BIGINT CHECK (
    stdout_byte_count IS NULL OR stdout_byte_count >= 0
  ),
  stdout_sha256 TEXT CHECK (
    stdout_sha256 IS NULL OR stdout_sha256 ~ '^[0-9a-f]{64}$'
  ),
  stderr_byte_count BIGINT CHECK (
    stderr_byte_count IS NULL OR stderr_byte_count >= 0
  ),
  stderr_sha256 TEXT CHECK (
    stderr_sha256 IS NULL OR stderr_sha256 ~ '^[0-9a-f]{64}$'
  ),
  combined_output_byte_count BIGINT CHECK (
    combined_output_byte_count IS NULL OR combined_output_byte_count >= 0
  ),
  stdout_artifact JSONB CHECK (
    stdout_artifact IS NULL OR jsonb_typeof(stdout_artifact) = 'object'
  ),
  stderr_artifact JSONB CHECK (
    stderr_artifact IS NULL OR jsonb_typeof(stderr_artifact) = 'object'
  ),
  required_evidence_state TEXT NOT NULL DEFAULT 'pending' CHECK (
    required_evidence_state IN ('pending', 'complete')
  ),
  launcher_output_acknowledged BOOLEAN NOT NULL DEFAULT false,
  cancellation_requested BOOLEAN NOT NULL DEFAULT false,
  cancellation_requested_at TIMESTAMPTZ,
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR length(cancellation_reason) <= 1024
  ),
  last_reconciliation_result JSONB CHECK (
    last_reconciliation_result IS NULL OR
    jsonb_typeof(last_reconciliation_result) = 'object'
  ),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT process_operations_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT process_operations_state_shape CHECK (
    (lifecycle_state = 'intent' AND terminal_result IS NULL AND terminal_at IS NULL) OR
    (lifecycle_state = 'active' AND launcher_acceptance_identity IS NOT NULL
      AND terminal_result IS NULL AND terminal_at IS NULL) OR
    (lifecycle_state = 'finalizing'
      AND (
        launcher_acceptance_identity IS NOT NULL OR
        terminal_outcome IN ('cancelled', 'failed_to_start')
      )
      AND terminal_result IS NOT NULL AND terminal_result_hash IS NOT NULL
      AND terminal_at IS NOT NULL) OR
    (lifecycle_state = 'terminal' AND terminal_result IS NOT NULL
      AND terminal_result_hash IS NOT NULL AND terminal_at IS NOT NULL
      AND required_evidence_state = 'complete')
  ),
  CONSTRAINT process_operations_output_shape CHECK (
    (stdout_byte_count IS NULL AND stdout_sha256 IS NULL) OR
    (stdout_byte_count IS NOT NULL AND stdout_sha256 IS NOT NULL)
  ),
  CONSTRAINT process_operations_stderr_shape CHECK (
    (stderr_byte_count IS NULL AND stderr_sha256 IS NULL) OR
    (stderr_byte_count IS NOT NULL AND stderr_sha256 IS NOT NULL)
  ),
  CONSTRAINT process_operations_combined_output_shape CHECK (
    combined_output_byte_count IS NULL OR
    (
      stdout_byte_count IS NOT NULL AND stderr_byte_count IS NOT NULL AND
      combined_output_byte_count = stdout_byte_count + stderr_byte_count
    )
  ),
  CONSTRAINT process_operations_cancellation_shape CHECK (
    (cancellation_requested = false AND cancellation_requested_at IS NULL) OR
    (cancellation_requested = true AND cancellation_requested_at IS NOT NULL)
  )
);

CREATE INDEX process_operations_run_state_idx
  ON process_operations (run_id, lifecycle_state, operation_identity);

CREATE INDEX process_operations_nonterminal_idx
  ON process_operations (updated_at, operation_identity)
  WHERE lifecycle_state <> 'terminal';

CREATE FUNCTION enforce_process_operation_lifecycle() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'process operations cannot be deleted';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'process operation revision must advance exactly once';
  END IF;
  IF NEW.operation_identity <> OLD.operation_identity OR
     NEW.run_id <> OLD.run_id OR
     NEW.ticket_id <> OLD.ticket_id OR
     NEW.acting_agent_id <> OLD.acting_agent_id OR
     NEW.step_id IS DISTINCT FROM OLD.step_id OR
     NEW.runtime_phase <> OLD.runtime_phase OR
     NEW.target_id <> OLD.target_id OR
     NEW.profile_id <> OLD.profile_id OR
     NEW.policy_snapshot_hash <> OLD.policy_snapshot_hash OR
     NEW.runtime_capability_generation <> OLD.runtime_capability_generation OR
     NEW.launch_plan_version <> OLD.launch_plan_version OR
     NEW.launch_plan_hash <> OLD.launch_plan_hash OR
     NEW.launch_plan <> OLD.launch_plan OR
     NEW.workspace_snapshot_id <> OLD.workspace_snapshot_id OR
     NEW.workspace_manifest_hash <> OLD.workspace_manifest_hash OR
     NEW.materializer_generation <> OLD.materializer_generation OR
     NEW.containment_generation_id <> OLD.containment_generation_id OR
     NEW.rootfs_id <> OLD.rootfs_id OR
     NEW.rootfs_manifest_hash <> OLD.rootfs_manifest_hash OR
     NEW.executable_identity_hash <> OLD.executable_identity_hash OR
     NEW.execution_policy_hash <> OLD.execution_policy_hash OR
     NEW.filesystem_policy_hash <> OLD.filesystem_policy_hash OR
     NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'process operation authority is immutable';
  END IF;
  IF OLD.lifecycle_state = 'terminal' AND NEW.lifecycle_state <> 'terminal' THEN
    RAISE EXCEPTION 'terminal process operations cannot be reopened';
  END IF;
  IF (OLD.lifecycle_state, NEW.lifecycle_state) NOT IN (
    ('intent', 'intent'),
    ('intent', 'active'),
    ('intent', 'finalizing'),
    ('intent', 'terminal'),
    ('active', 'active'),
    ('active', 'finalizing'),
    ('active', 'terminal'),
    ('finalizing', 'finalizing'),
    ('finalizing', 'terminal'),
    ('terminal', 'terminal')
  ) THEN
    RAISE EXCEPTION 'invalid process operation lifecycle transition';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER process_operations_lifecycle_guard
BEFORE UPDATE OR DELETE ON process_operations
FOR EACH ROW EXECUTE FUNCTION enforce_process_operation_lifecycle();
