-- Mutable process-template authority. New templates always have an active immutable
-- version; root pointers, schedule columns/body, and trigger provenance must agree.
ALTER TABLE process_template_versions
  ADD CONSTRAINT process_template_versions_identity_unique
  UNIQUE (template_id, id, version);

ALTER TABLE process_templates
  ALTER COLUMN current_version_id SET NOT NULL,
  ADD CONSTRAINT process_templates_active_version_fk
    FOREIGN KEY (id, current_version_id, current_version)
    REFERENCES process_template_versions (template_id, id, version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT process_templates_schedule_body_shape CHECK (
    (
      schedule_enabled = FALSE AND next_run_at IS NULL AND
      (
        body->'schedule' IS NULL OR body->'schedule' = 'null'::jsonb OR
        (jsonb_typeof(body->'schedule') = 'object' AND COALESCE((body->'schedule'->>'enabled')::boolean, FALSE) = FALSE)
      )
    ) OR (
      schedule_enabled = TRUE AND next_run_at IS NOT NULL AND
      jsonb_typeof(body->'schedule') = 'object' AND
      body->'schedule'->>'kind' = 'interval' AND
      (body->'schedule'->>'enabled')::boolean = TRUE AND
      (body->'schedule'->>'everySeconds')::bigint > 0 AND
      (body->'schedule'->>'nextRunAt')::timestamptz = next_run_at
    )
  );

ALTER TABLE process_template_triggers
  ADD CONSTRAINT process_template_triggers_template_version_fk
  FOREIGN KEY (template_id, template_version)
  REFERENCES process_template_versions (template_id, version)
  ON DELETE RESTRICT;

CREATE INDEX process_template_triggers_template_version_idx
  ON process_template_triggers (template_id, template_version);
