ALTER TABLE access_groups
  ADD COLUMN planner_agent_id BIGINT,
  ADD CONSTRAINT access_groups_planner_agent_fk
    FOREIGN KEY (planner_agent_id) REFERENCES configured_agents(id) ON DELETE RESTRICT;

CREATE INDEX access_groups_planner_agent_id_idx
  ON access_groups (planner_agent_id, id)
  WHERE planner_agent_id IS NOT NULL;

CREATE FUNCTION enforce_access_group_planner_membership() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
  checked_group_ids BIGINT[];
BEGIN
  IF TG_TABLE_NAME = 'access_groups' THEN
    checked_group_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    checked_group_ids := ARRAY[OLD.group_id];
  ELSE
    checked_group_ids := ARRAY[OLD.group_id, NEW.group_id];
  END IF;

  IF EXISTS (
    SELECT 1
    FROM access_groups AS access_group
    WHERE access_group.id = ANY(checked_group_ids)
      AND access_group.planner_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM agent_group_memberships AS membership
        WHERE membership.group_id = access_group.id
          AND membership.agent_id = access_group.planner_agent_id
      )
  ) THEN
    RAISE EXCEPTION 'designated group planner must remain a current group member'
      USING ERRCODE = '23514',
            CONSTRAINT = 'access_groups_planner_membership_required';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER access_groups_planner_membership_guard
AFTER INSERT OR UPDATE OF planner_agent_id ON access_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_group_planner_membership();

CREATE CONSTRAINT TRIGGER agent_group_planner_membership_guard
AFTER DELETE OR UPDATE OF agent_id, group_id ON agent_group_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_group_planner_membership();
