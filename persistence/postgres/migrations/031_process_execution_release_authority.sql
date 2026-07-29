-- Tranche 8: immutable migration identities and the restart-durable process
-- admission/release-generation authority. Process execution remains disabled
-- until an operator explicitly binds this singleton to a validated release.

CREATE TABLE schema_migration_identities (
  version TEXT PRIMARY KEY REFERENCES schema_migrations(version) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION enforce_schema_migration_identity_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'schema migration identities are append-only';
END;
$function$;

CREATE TRIGGER schema_migration_identities_append_only
BEFORE UPDATE OR DELETE ON schema_migration_identities
FOR EACH ROW EXECUTE FUNCTION enforce_schema_migration_identity_append_only();

CREATE TABLE process_execution_release_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admission_enabled BOOLEAN NOT NULL DEFAULT false,
  release_contract_hash TEXT CHECK (
    release_contract_hash IS NULL OR release_contract_hash ~ '^[0-9a-f]{64}$'
  ),
  source_revision TEXT CHECK (
    source_revision IS NULL OR source_revision ~ '^[0-9a-f]{40}$'
  ),
  application_version TEXT CHECK (
    application_version IS NULL OR
    application_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$'
  ),
  changed_by TEXT NOT NULL DEFAULT 'migration' CHECK (
    length(btrim(changed_by)) BETWEEN 1 AND 256
  ),
  change_reason TEXT NOT NULL DEFAULT 'initial default-off release authority' CHECK (
    length(btrim(change_reason)) BETWEEN 1 AND 1024
  ),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT process_execution_release_state_singleton CHECK (id = 1),
  CONSTRAINT process_execution_release_state_enablement CHECK (
    admission_enabled = false OR (
      release_contract_hash IS NOT NULL AND
      source_revision IS NOT NULL AND
      application_version IS NOT NULL
    )
  )
);

INSERT INTO process_execution_release_state (
  id,
  admission_enabled,
  changed_by,
  change_reason
) VALUES (
  1,
  false,
  'migration',
  'initial default-off release authority'
);

CREATE FUNCTION enforce_process_execution_release_state() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'process execution release authority cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'process execution release authority identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'process execution release authority revision must advance exactly once';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'process execution release authority timestamp must advance';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER process_execution_release_state_guard
BEFORE UPDATE OR DELETE ON process_execution_release_state
FOR EACH ROW EXECUTE FUNCTION enforce_process_execution_release_state();
