CREATE TABLE access_permissions (
  name TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT access_permissions_name_trimmed CHECK (length(btrim(name)) > 0 AND name = btrim(name))
);

CREATE INDEX access_permissions_name_c_idx ON access_permissions (name COLLATE "C");

INSERT INTO access_permissions (name) VALUES
  ('ticket:create'),
  ('ticket:read'),
  ('ticket:update'),
  ('ticket:delete'),
  ('user:create'),
  ('user:read'),
  ('user:update'),
  ('user:delete'),
  ('group:create'),
  ('group:read'),
  ('group:update'),
  ('group:delete'),
  ('permission:assign'),
  ('workflow:manage'),
  ('workspace:read'),
  ('workspace:write'),
  ('workspace:reset'),
  ('workspace.delete.cross_ticket_artifact'),
  ('browser:read'),
  ('browser:operate'),
  ('processTemplate:manage'),
  ('workContext:manage'),
  ('watcher:manage'),
  ('modelRouting:manage'),
  ('connector:manage'),
  ('connector:read'),
  ('connector:write'),
  ('ops:read'),
  ('runtimeLimits:manage');

CREATE FUNCTION reject_access_permission_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'access permissions are migration-owned';
END;
$function$;

CREATE TRIGGER access_permissions_migration_owned
BEFORE INSERT OR UPDATE OR DELETE ON access_permissions
FOR EACH ROW EXECUTE FUNCTION reject_access_permission_mutation();

CREATE TABLE access_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  can_receive_tickets BOOLEAN NOT NULL DEFAULT FALSE,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT access_groups_name_unique UNIQUE (name),
  CONSTRAINT access_groups_name_trimmed CHECK (length(btrim(name)) > 0 AND name = btrim(name)),
  CONSTRAINT access_groups_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT access_groups_revision_positive CHECK (revision > 0)
);

CREATE INDEX access_groups_ticket_capable_id_idx ON access_groups (can_receive_tickets, id);
CREATE INDEX access_groups_name_lower_id_idx ON access_groups (lower(name), id);

CREATE TRIGGER access_groups_revision_guard
BEFORE UPDATE ON access_groups
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TABLE access_group_permissions (
  group_id BIGINT NOT NULL,
  permission_name TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT access_group_permissions_pkey PRIMARY KEY (group_id, permission_name),
  CONSTRAINT access_group_permissions_group_fk FOREIGN KEY (group_id) REFERENCES access_groups(id) ON DELETE CASCADE,
  CONSTRAINT access_group_permissions_permission_fk FOREIGN KEY (permission_name) REFERENCES access_permissions(name) ON DELETE RESTRICT
);

CREATE INDEX access_group_permissions_permission_group_idx
  ON access_group_permissions (permission_name, group_id);

CREATE TABLE access_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL CHECK (length(btrim(password_hash)) > 0),
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT access_users_username_unique UNIQUE (username),
  CONSTRAINT access_users_username_trimmed CHECK (length(btrim(username)) > 0 AND username = btrim(username)),
  CONSTRAINT access_users_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT access_users_revision_positive CHECK (revision > 0)
);

CREATE INDEX access_users_username_lower_id_idx ON access_users (lower(username), id);

CREATE TRIGGER access_users_revision_guard
BEFORE UPDATE ON access_users
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TABLE user_group_memberships (
  user_id BIGINT NOT NULL,
  group_id BIGINT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_group_memberships_pkey PRIMARY KEY (user_id, group_id),
  CONSTRAINT user_group_memberships_user_fk FOREIGN KEY (user_id) REFERENCES access_users(id) ON DELETE CASCADE,
  CONSTRAINT user_group_memberships_group_fk FOREIGN KEY (group_id) REFERENCES access_groups(id) ON DELETE CASCADE
);

CREATE INDEX user_group_memberships_group_user_idx
  ON user_group_memberships (group_id, user_id);

ALTER TABLE agent_group_memberships
  ADD CONSTRAINT agent_group_memberships_group_fk
  FOREIGN KEY (group_id) REFERENCES access_groups(id) ON DELETE CASCADE;

ALTER TABLE tickets
  ADD COLUMN assignment_group_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN assignment_target_type = 'group' THEN assignment_target_id ELSE NULL END
  ) STORED,
  ADD CONSTRAINT tickets_assignment_group_fk
    FOREIGN KEY (assignment_group_id) REFERENCES access_groups(id) ON DELETE RESTRICT;

CREATE INDEX tickets_assignment_group_id_idx
  ON tickets (assignment_group_id, id)
  WHERE assignment_group_id IS NOT NULL;
