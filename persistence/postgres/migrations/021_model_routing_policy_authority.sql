CREATE TABLE model_routing_policies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  work_context_id BIGINT,
  capability_id TEXT,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_routing_policies_name_trimmed CHECK (length(btrim(name)) > 0),
  CONSTRAINT model_routing_policies_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT model_routing_policies_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT model_routing_policies_revision_positive CHECK (revision > 0),
  CONSTRAINT model_routing_policies_work_context_fk
    FOREIGN KEY (work_context_id) REFERENCES work_contexts(id) ON DELETE RESTRICT
);

CREATE INDEX model_routing_policies_dispatch_idx
  ON model_routing_policies (status, work_context_id, capability_id, id);

CREATE TRIGGER model_routing_policies_revision_guard
BEFORE UPDATE ON model_routing_policies
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tickets
    WHERE body ? 'routingPolicyId'
      AND body->'routingPolicyId' IS NOT NULL
      AND body->'routingPolicyId' <> 'null'::jsonb
  ) THEN
    RAISE EXCEPTION '021_model_routing_policy_authority requires disposable PostgreSQL ticket routing-policy data to be reset; no JSON importer or legacy compatibility path is provided';
  END IF;
END $$;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_routing_policy_body_shape CHECK (
    NOT (body ? 'routingPolicyId')
    OR body->'routingPolicyId' = 'null'::jsonb
    OR (
      jsonb_typeof(body->'routingPolicyId') = 'number'
      AND (body->>'routingPolicyId') !~ '[^0-9]'
      AND substr(body->>'routingPolicyId', 1, 1) <> '0'
    )
  );

ALTER TABLE tickets
  ADD COLUMN routing_policy_id BIGINT GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(body->'routingPolicyId') = 'number'
        AND (body->>'routingPolicyId') !~ '[^0-9]'
        AND substr(body->>'routingPolicyId', 1, 1) <> '0'
        THEN (body->>'routingPolicyId')::BIGINT
      ELSE NULL
    END
  ) STORED;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_routing_policy_fk
  FOREIGN KEY (routing_policy_id) REFERENCES model_routing_policies(id) ON DELETE RESTRICT;

CREATE INDEX tickets_routing_policy_id_idx ON tickets (routing_policy_id, id)
  WHERE routing_policy_id IS NOT NULL;
