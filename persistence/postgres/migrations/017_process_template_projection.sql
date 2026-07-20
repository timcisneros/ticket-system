CREATE TABLE process_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  work_context_id BIGINT REFERENCES work_contexts(id) ON DELETE RESTRICT,
  current_version BIGINT NOT NULL DEFAULT 1 CHECK (current_version > 0),
  current_version_id TEXT,
  schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  next_run_at TIMESTAMPTZ,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT process_templates_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT process_templates_revision_positive CHECK (revision > 0),
  CONSTRAINT process_templates_schedule_cursor CHECK (
    (schedule_enabled = TRUE AND next_run_at IS NOT NULL) OR
    (schedule_enabled = FALSE AND next_run_at IS NULL)
  )
);

CREATE INDEX process_templates_work_context_id_idx ON process_templates (work_context_id, id);
CREATE INDEX process_templates_enabled_id_idx ON process_templates (enabled, id);
CREATE INDEX process_templates_due_idx ON process_templates (next_run_at, id)
  WHERE enabled = TRUE AND schedule_enabled = TRUE;

CREATE TRIGGER process_templates_revision_guard
BEFORE UPDATE ON process_templates
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();
CREATE TABLE process_template_status_counts (
  shard SMALLINT PRIMARY KEY,
  total BIGINT NOT NULL,
  enabled BIGINT NOT NULL,
  disabled BIGINT NOT NULL,
  scheduled BIGINT NOT NULL,
  paused_schedule BIGINT NOT NULL,
  CONSTRAINT process_template_status_counts_shard_range CHECK (shard >= 0 AND shard < 256),
  CONSTRAINT process_template_status_counts_nonnegative CHECK (
    total >= 0 AND enabled >= 0 AND disabled >= 0 AND scheduled >= 0 AND paused_schedule >= 0
  )
);

LOCK TABLE process_templates IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO process_template_status_counts
  (shard, total, enabled, disabled, scheduled, paused_schedule)
SELECT mod(id, 256)::smallint,
       COUNT(*)::bigint,
       COUNT(*) FILTER (WHERE enabled = TRUE)::bigint,
       COUNT(*) FILTER (WHERE enabled = FALSE)::bigint,
       COUNT(*) FILTER (WHERE schedule_enabled = TRUE)::bigint,
       COUNT(*) FILTER (
         WHERE jsonb_typeof(body->'schedule') = 'object' AND schedule_enabled = FALSE
       )::bigint
FROM process_templates
GROUP BY mod(id, 256);

CREATE FUNCTION maintain_process_template_status_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  prior_shard SMALLINT;
  next_shard SMALLINT;
  prior_paused BOOLEAN;
  next_paused BOOLEAN;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    prior_shard := mod(OLD.id, 256)::smallint;
    prior_paused := jsonb_typeof(OLD.body->'schedule') = 'object' AND OLD.schedule_enabled = FALSE;
    UPDATE process_template_status_counts
    SET total = total - 1,
        enabled = enabled - CASE WHEN OLD.enabled THEN 1 ELSE 0 END,
        disabled = disabled - CASE WHEN OLD.enabled THEN 0 ELSE 1 END,
        scheduled = scheduled - CASE WHEN OLD.schedule_enabled THEN 1 ELSE 0 END,
        paused_schedule = paused_schedule - CASE WHEN prior_paused THEN 1 ELSE 0 END
    WHERE shard = prior_shard;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing process-template status count for shard %', prior_shard;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    next_shard := mod(NEW.id, 256)::smallint;
    next_paused := jsonb_typeof(NEW.body->'schedule') = 'object' AND NEW.schedule_enabled = FALSE;
    INSERT INTO process_template_status_counts
      (shard, total, enabled, disabled, scheduled, paused_schedule)
    VALUES (
      next_shard,
      1,
      CASE WHEN NEW.enabled THEN 1 ELSE 0 END,
      CASE WHEN NEW.enabled THEN 0 ELSE 1 END,
      CASE WHEN NEW.schedule_enabled THEN 1 ELSE 0 END,
      CASE WHEN next_paused THEN 1 ELSE 0 END
    )
    ON CONFLICT (shard) DO UPDATE
    SET total = process_template_status_counts.total + 1,
        enabled = process_template_status_counts.enabled + EXCLUDED.enabled,
        disabled = process_template_status_counts.disabled + EXCLUDED.disabled,
        scheduled = process_template_status_counts.scheduled + EXCLUDED.scheduled,
        paused_schedule = process_template_status_counts.paused_schedule + EXCLUDED.paused_schedule;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER process_templates_status_count
AFTER INSERT OR DELETE OR UPDATE OF id, enabled, schedule_enabled, body ON process_templates
FOR EACH ROW EXECUTE FUNCTION maintain_process_template_status_count();

CREATE TABLE process_template_versions (
  id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
  template_id BIGINT NOT NULL REFERENCES process_templates(id) ON DELETE RESTRICT,
  version BIGINT NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'discarded')),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  ticket_template JSONB NOT NULL,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  activated_by TEXT,
  activated_at TIMESTAMPTZ,
  supersedes_version_id TEXT REFERENCES process_template_versions(id) ON DELETE RESTRICT,
  CONSTRAINT process_template_versions_template_version_unique UNIQUE (template_id, version),
  CONSTRAINT process_template_versions_ticket_template_object CHECK (jsonb_typeof(ticket_template) = 'object'),
  CONSTRAINT process_template_versions_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT process_template_versions_activation_shape CHECK (
    (status IN ('draft', 'discarded') AND activated_by IS NULL AND activated_at IS NULL) OR
    (status IN ('active', 'superseded') AND activated_by IS NOT NULL AND activated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX process_template_versions_one_active_idx
  ON process_template_versions (template_id) WHERE status = 'active';
CREATE UNIQUE INDEX process_template_versions_one_draft_idx
  ON process_template_versions (template_id) WHERE status = 'draft';
CREATE INDEX process_template_versions_template_version_idx
  ON process_template_versions (template_id, version DESC);

CREATE FUNCTION enforce_process_template_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'process-template versions are append-only';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.ticket_template IS DISTINCT FROM OLD.ticket_template
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'process-template version content is immutable';
  END IF;

  IF (NEW.activated_by IS DISTINCT FROM OLD.activated_by
      OR NEW.activated_at IS DISTINCT FROM OLD.activated_at)
     AND NOT (OLD.status = 'draft' AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'process-template version activation provenance is immutable';
  END IF;

  IF NOT (
    NEW.status = OLD.status OR
    (OLD.status = 'draft' AND NEW.status IN ('active', 'discarded')) OR
    (OLD.status = 'active' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'invalid process-template version status transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER process_template_versions_immutability_guard
BEFORE UPDATE OR DELETE ON process_template_versions
FOR EACH ROW EXECUTE FUNCTION enforce_process_template_version_immutability();

CREATE TABLE process_template_triggers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger_token TEXT NOT NULL UNIQUE CHECK (length(btrim(trigger_token)) > 0),
  template_id BIGINT NOT NULL REFERENCES process_templates(id) ON DELETE RESTRICT,
  template_version BIGINT NOT NULL CHECK (template_version > 0),
  ticket_id BIGINT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE RESTRICT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'schedule')),
  triggered_by TEXT NOT NULL CHECK (length(btrim(triggered_by)) > 0),
  scheduled_for TIMESTAMPTZ,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT process_template_triggers_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT process_template_triggers_schedule_shape CHECK (
    (trigger_type = 'manual' AND scheduled_for IS NULL) OR
    (trigger_type = 'schedule' AND scheduled_for IS NOT NULL)
  )
);

CREATE INDEX process_template_triggers_template_id_idx
  ON process_template_triggers (template_id, id DESC);
CREATE INDEX process_template_triggers_ticket_id_idx
  ON process_template_triggers (ticket_id);

CREATE TRIGGER process_template_triggers_append_only
BEFORE UPDATE OR DELETE ON process_template_triggers
FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();
