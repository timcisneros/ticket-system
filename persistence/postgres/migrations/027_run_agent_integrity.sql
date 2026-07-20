-- A runnable record must reference a configured agent. Admission and provider
-- concurrency classification must never depend on an optional catalog join.

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM runs AS run
    LEFT JOIN configured_agents AS agent ON agent.id = run.agent_id
    WHERE agent.id IS NULL
  ) THEN
    RAISE EXCEPTION '027_run_agent_integrity requires disposable PostgreSQL run data with valid configured agents; reset development runs before migrating';
  END IF;
END;
$block$;

ALTER TABLE runs
  ADD CONSTRAINT runs_configured_agent_fk
  FOREIGN KEY (agent_id) REFERENCES configured_agents(id) ON DELETE RESTRICT;
