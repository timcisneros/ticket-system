CREATE TABLE configured_agents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT configured_agents_name_unique UNIQUE (name),
  CONSTRAINT configured_agents_provider_check CHECK (provider IN ('openai', 'ollama')),
  CONSTRAINT configured_agents_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT configured_agents_revision_positive CHECK (revision > 0)
);

CREATE INDEX configured_agents_provider_id_idx ON configured_agents (provider, id);
CREATE INDEX configured_agents_name_lower_id_idx ON configured_agents (lower(name), id);

CREATE TRIGGER configured_agents_revision_guard
BEFORE UPDATE ON configured_agents
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

CREATE TABLE agent_group_memberships (
  agent_id BIGINT NOT NULL,
  group_id BIGINT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_group_memberships_pkey PRIMARY KEY (agent_id, group_id),
  CONSTRAINT agent_group_memberships_agent_fk FOREIGN KEY (agent_id) REFERENCES configured_agents(id) ON DELETE CASCADE,
  CONSTRAINT agent_group_memberships_group_positive CHECK (group_id > 0)
);

CREATE INDEX agent_group_memberships_group_agent_idx
  ON agent_group_memberships (group_id, agent_id);
