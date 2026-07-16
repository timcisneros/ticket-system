CREATE OR REPLACE FUNCTION enforce_replay_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  changed_key TEXT;
  changed_count INTEGER;
  prior_length INTEGER;
  item_index INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'replay snapshots cannot be deleted';
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.ticket_id <> OLD.ticket_id THEN
    RAISE EXCEPTION 'replay snapshot ownership is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'replay snapshot revision must advance exactly once';
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
      RAISE EXCEPTION 'finalized replay terminal fields are immutable';
    END IF;
    SELECT COUNT(*), MIN(keys.key)
      INTO changed_count, changed_key
      FROM (
        SELECT jsonb_object_keys(OLD.snapshot) AS key
        UNION
        SELECT jsonb_object_keys(NEW.snapshot) AS key
      ) AS keys
      WHERE (OLD.snapshot -> keys.key) IS DISTINCT FROM (NEW.snapshot -> keys.key);
    IF changed_count <> 1 OR
       jsonb_typeof(OLD.snapshot -> changed_key) <> 'array' OR
       jsonb_typeof(NEW.snapshot -> changed_key) <> 'array' THEN
      RAISE EXCEPTION 'finalized replay permits only one append-only evidence item';
    END IF;
    prior_length := jsonb_array_length(OLD.snapshot -> changed_key);
    IF jsonb_array_length(NEW.snapshot -> changed_key) <> prior_length + 1 THEN
      RAISE EXCEPTION 'finalized replay permits only one append-only evidence item';
    END IF;
    IF prior_length > 0 THEN
      FOR item_index IN 0..(prior_length - 1) LOOP
        IF (OLD.snapshot -> changed_key -> item_index) IS DISTINCT FROM
           (NEW.snapshot -> changed_key -> item_index) THEN
          RAISE EXCEPTION 'finalized replay evidence prefix is immutable';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
