-- Current-format process-template tickets must identify the exact immutable
-- template version and trigger that created them. The runtime does not carry a
-- compatibility projection for unversioned development records.

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tickets
    WHERE body->'source'->>'type' = 'process_template'
      AND NOT COALESCE(
        jsonb_typeof(body->'source') = 'object'
        AND jsonb_typeof(body->'source'->'templateId') = 'number'
        AND (body->'source'->>'templateId') ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(body->'source'->'templateVersion') = 'number'
        AND (body->'source'->>'templateVersion') ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(body->'source'->'triggerToken') = 'string'
        AND length(btrim(body->'source'->>'triggerToken')) > 0,
        false
      )
  ) THEN
    RAISE EXCEPTION '028_process_template_ticket_provenance requires disposable development tickets with current-format process-template provenance; reset invalid development tickets before migrating';
  END IF;
END;
$block$;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_process_template_source_current_shape CHECK (
    body->'source'->>'type' IS DISTINCT FROM 'process_template'
    OR COALESCE(
      jsonb_typeof(body->'source') = 'object'
      AND jsonb_typeof(body->'source'->'templateId') = 'number'
      AND (body->'source'->>'templateId') ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(body->'source'->'templateVersion') = 'number'
      AND (body->'source'->>'templateVersion') ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(body->'source'->'triggerToken') = 'string'
      AND length(btrim(body->'source'->>'triggerToken')) > 0,
      false
    )
  ),
  ADD COLUMN process_template_source_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN body->'source'->>'type' = 'process_template'
      THEN (body->'source'->>'templateId')::bigint
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN process_template_source_version BIGINT GENERATED ALWAYS AS (
    CASE WHEN body->'source'->>'type' = 'process_template'
      THEN (body->'source'->>'templateVersion')::bigint
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN process_template_trigger_token TEXT GENERATED ALWAYS AS (
    CASE WHEN body->'source'->>'type' = 'process_template'
      THEN body->'source'->>'triggerToken'
      ELSE NULL
    END
  ) STORED;

ALTER TABLE process_template_triggers
  ADD CONSTRAINT process_template_triggers_ticket_source_identity_unique
  UNIQUE (trigger_token, template_id, template_version, ticket_id);

ALTER TABLE tickets
  ADD CONSTRAINT tickets_process_template_trigger_source_fk
  FOREIGN KEY (
    process_template_trigger_token,
    process_template_source_id,
    process_template_source_version,
    id
  ) REFERENCES process_template_triggers (
    trigger_token,
    template_id,
    template_version,
    ticket_id
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX tickets_process_template_source_idx
  ON tickets (process_template_source_id, process_template_source_version, id)
  WHERE process_template_trigger_token IS NOT NULL;
