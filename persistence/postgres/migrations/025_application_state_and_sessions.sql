-- Final server cutover: the remaining runtime-owned catalogs, coordination
-- projections, and HTTP sessions live in PostgreSQL. Current development data
-- is intentionally not imported from the retired JSON stores.

CREATE TABLE browser_targets (
  id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  body JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER browser_targets_revision_guard
BEFORE UPDATE ON browser_targets
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE INDEX browser_targets_status_id_idx ON browser_targets (status, id);

CREATE TABLE work_types (
  id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  body JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER work_types_revision_guard
BEFORE UPDATE ON work_types
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE INDEX work_types_status_id_idx ON work_types (status, id);

CREATE SEQUENCE allocation_item_id_seq AS BIGINT;

CREATE TABLE allocation_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
  body JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER allocation_plans_revision_guard
BEFORE UPDATE ON allocation_plans
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE INDEX allocation_plans_ticket_id_id_idx ON allocation_plans (ticket_id, id);
CREATE INDEX allocation_plans_status_id_idx ON allocation_plans (status, id);

CREATE TABLE message_threads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_key TEXT NOT NULL UNIQUE CHECK (length(btrim(thread_key)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('blocker', 'deliverable')),
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  run_id BIGINT REFERENCES runs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  body JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  CONSTRAINT message_threads_run_ticket_fk
    FOREIGN KEY (run_id, ticket_id) REFERENCES runs(id, ticket_id),
  CONSTRAINT message_threads_close_shape CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by IS NULL) OR
    (status = 'closed' AND closed_at IS NOT NULL AND length(btrim(closed_by)) > 0)
  )
);

CREATE TRIGGER message_threads_revision_guard
BEFORE UPDATE ON message_threads
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE INDEX message_threads_status_updated_id_idx ON message_threads (status, updated_at DESC, id DESC);
CREATE INDEX message_threads_ticket_id_id_idx ON message_threads (ticket_id, id);
CREATE INDEX message_threads_run_id_id_idx ON message_threads (run_id, id) WHERE run_id IS NOT NULL;

CREATE TABLE message_thread_messages (
  thread_id BIGINT NOT NULL REFERENCES message_threads(id) ON DELETE RESTRICT,
  message_id BIGINT NOT NULL CHECK (message_id > 0),
  author TEXT NOT NULL CHECK (length(btrim(author)) > 0),
  author_name TEXT NOT NULL CHECK (length(btrim(author_name)) > 0),
  kind TEXT NOT NULL CHECK (length(btrim(kind)) > 0),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (thread_id, message_id)
);

CREATE OR REPLACE FUNCTION prevent_message_thread_message_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'message thread messages are append-only';
END;
$$;

CREATE TRIGGER message_thread_messages_append_only
BEFORE UPDATE OR DELETE ON message_thread_messages
FOR EACH ROW EXECUTE FUNCTION prevent_message_thread_message_mutation();

CREATE TABLE http_sessions (
  sid TEXT PRIMARY KEY CHECK (length(btrim(sid)) > 0),
  session JSONB NOT NULL CHECK (jsonb_typeof(session) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX http_sessions_expires_at_idx ON http_sessions (expires_at);
