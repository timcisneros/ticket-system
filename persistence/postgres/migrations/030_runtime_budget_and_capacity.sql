-- Tranche 5: immutable effective run-budget authority, exactly-once durable
-- reservations/charges, and PostgreSQL-coordinated bounded capacity ownership.

ALTER TABLE runtime_limit_config
  ADD COLUMN max_attempts BIGINT,
  ADD COLUMN max_process_operations_per_run BIGINT,
  ADD COLUMN max_browser_operations_per_run BIGINT,
  ADD COLUMN max_output_artifact_bytes_per_run BIGINT;

ALTER TABLE runtime_limit_config
  DROP CONSTRAINT runtime_limit_config_values,
  ADD CONSTRAINT runtime_limit_config_values CHECK (
    (max_attempts IS NULL OR max_attempts >= 1) AND
    (max_execution_steps IS NULL OR max_execution_steps >= 1) AND
    (max_model_requests_per_run IS NULL OR max_model_requests_per_run >= 1) AND
    (max_workspace_operations_per_run IS NULL OR max_workspace_operations_per_run >= 1) AND
    (max_process_operations_per_run IS NULL OR max_process_operations_per_run >= 1) AND
    (max_browser_operations_per_run IS NULL OR max_browser_operations_per_run >= 1) AND
    (max_runtime_duration_ms IS NULL OR max_runtime_duration_ms >= 5000) AND
    (max_output_artifact_bytes_per_run IS NULL OR max_output_artifact_bytes_per_run >= 1) AND
    (max_active_runs IS NULL OR max_active_runs >= 1) AND
    (local_model_concurrency IS NULL OR local_model_concurrency >= 1)
  );

CREATE TABLE run_budget_charges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  dimension TEXT NOT NULL CHECK (
    dimension IN (
      'execution_step',
      'model_request',
      'workspace_operation',
      'process_operation',
      'browser_operation',
      'output_artifact_bytes'
    )
  ),
  source_identity TEXT NOT NULL CHECK (
    length(btrim(source_identity)) BETWEEN 1 AND 512
  ),
  reserved_amount BIGINT NOT NULL CHECK (reserved_amount > 0),
  committed_amount BIGINT NOT NULL DEFAULT 0 CHECK (
    committed_amount >= 0 AND committed_amount <= reserved_amount
  ),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (
    state IN ('reserved', 'committed', 'released')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  CONSTRAINT run_budget_charges_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT run_budget_charges_identity UNIQUE (run_id, dimension, source_identity),
  CONSTRAINT run_budget_charges_state_shape CHECK (
    (state = 'reserved' AND committed_amount = 0 AND committed_at IS NULL AND released_at IS NULL) OR
    (state = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL) OR
    (state = 'released' AND committed_amount = 0 AND committed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX run_budget_charges_usage_idx
  ON run_budget_charges (run_id, dimension, state, id);

CREATE FUNCTION enforce_run_budget_charge_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runtime budget charges cannot be deleted';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'run budget charge revision must advance exactly once';
  END IF;
  IF NEW.run_id <> OLD.run_id OR
     NEW.ticket_id <> OLD.ticket_id OR
     NEW.dimension <> OLD.dimension OR
     NEW.source_identity <> OLD.source_identity OR
     NEW.reserved_amount <> OLD.reserved_amount OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'run budget charge authority is immutable';
  END IF;
  IF OLD.state <> 'reserved' OR NEW.state NOT IN ('committed', 'released') THEN
    RAISE EXCEPTION 'run budget charge transitions are forward-only';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER run_budget_charge_transition_guard
BEFORE UPDATE OR DELETE ON run_budget_charges
FOR EACH ROW EXECUTE FUNCTION enforce_run_budget_charge_transition();

CREATE TABLE runtime_capacity_slots (
  capacity_domain TEXT NOT NULL CHECK (
    capacity_domain IN ('global_run', 'model_provider', 'target', 'process_launcher')
  ),
  resource_key TEXT NOT NULL CHECK (
    length(btrim(resource_key)) BETWEEN 1 AND 256
  ),
  slot_number INTEGER NOT NULL CHECK (slot_number > 0),
  lease_owner TEXT,
  run_id BIGINT REFERENCES runs(id) ON DELETE RESTRICT,
  operation_identity TEXT,
  lease_expires_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (capacity_domain, resource_key, slot_number),
  CONSTRAINT runtime_capacity_slot_ownership_shape CHECK (
    (
      lease_owner IS NULL AND run_id IS NULL AND operation_identity IS NULL AND
      lease_expires_at IS NULL AND acquired_at IS NULL
    ) OR (
      lease_owner IS NOT NULL AND length(btrim(lease_owner)) BETWEEN 1 AND 256 AND
      run_id IS NOT NULL AND lease_expires_at IS NOT NULL AND acquired_at IS NOT NULL
    )
  )
);

CREATE INDEX runtime_capacity_slots_lease_idx
  ON runtime_capacity_slots (lease_expires_at)
  WHERE lease_owner IS NOT NULL;

CREATE FUNCTION enforce_runtime_capacity_slot_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runtime capacity slots cannot be deleted';
  END IF;
  IF NEW.capacity_domain <> OLD.capacity_domain OR
     NEW.resource_key <> OLD.resource_key OR
     NEW.slot_number <> OLD.slot_number THEN
    RAISE EXCEPTION 'runtime capacity slot identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'runtime capacity slot revision must advance exactly once';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER runtime_capacity_slot_transition_guard
BEFORE UPDATE OR DELETE ON runtime_capacity_slots
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_capacity_slot_transition();

CREATE TABLE run_capacity_waits (
  run_id BIGINT PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  capacity_domain TEXT NOT NULL CHECK (
    capacity_domain IN ('global_run', 'model_provider', 'target', 'process_launcher')
  ),
  resource_key TEXT NOT NULL CHECK (
    length(btrim(resource_key)) BETWEEN 1 AND 256
  ),
  source_identity TEXT NOT NULL CHECK (
    length(btrim(source_identity)) BETWEEN 1 AND 512
  ),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1024),
  first_blocked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  next_eligible_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_capacity_waits_run_ticket_fk FOREIGN KEY (run_id, ticket_id)
    REFERENCES runs(id, ticket_id) ON DELETE RESTRICT
);

CREATE INDEX run_capacity_waits_fairness_idx
  ON run_capacity_waits (
    capacity_domain,
    resource_key,
    active,
    first_blocked_at,
    run_id
  );

CREATE FUNCTION reject_runtime_budget_authority_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runtime budget authority cannot be deleted';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'runtime budget authority revision must advance exactly once';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER run_capacity_waits_guard
BEFORE UPDATE OR DELETE ON run_capacity_waits
FOR EACH ROW EXECUTE FUNCTION reject_runtime_budget_authority_delete();
