-- Ticket-owned cancellation authority substrate.
--
-- This migration deliberately does not alter the historical Ticket status
-- vocabulary. Materialized `canceled` status belongs to the atomic five-state
-- cutover; this row-level authority is usable before that cutover.

ALTER TABLE tickets
  ADD COLUMN cancellation_authority JSONB;

CREATE FUNCTION validate_ticket_cancellation_authority_shape(
  authority JSONB,
  owner_ticket_id BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  key TEXT;
  parsed_committed_at TIMESTAMPTZ;
BEGIN
  IF authority IS NULL THEN
    RETURN TRUE;
  END IF;
  IF jsonb_typeof(authority) <> 'object' THEN
    RETURN FALSE;
  END IF;
  IF NOT authority ?& ARRAY[
    'version', 'ticketId', 'authoritySource', 'requestedBy', 'reason', 'committedAt'
  ] THEN
    RETURN FALSE;
  END IF;
  FOR key IN SELECT jsonb_object_keys(authority) LOOP
    IF key <> ALL (ARRAY[
      'version', 'ticketId', 'authoritySource', 'requestedBy', 'reason', 'committedAt'
    ]) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  IF COALESCE(jsonb_typeof(authority->'version') <> 'number', TRUE) OR
     authority->>'version' <> '1' OR
     COALESCE(jsonb_typeof(authority->'ticketId') <> 'number', TRUE) OR
     authority->>'ticketId' <> owner_ticket_id::text THEN
    RETURN FALSE;
  END IF;
  IF COALESCE(jsonb_typeof(authority->'authoritySource') <> 'string', TRUE) OR
     length(btrim(COALESCE(authority->>'authoritySource', ''))) NOT BETWEEN 1 AND 128 OR
     COALESCE(jsonb_typeof(authority->'requestedBy') <> 'string', TRUE) OR
     length(btrim(COALESCE(authority->>'requestedBy', ''))) NOT BETWEEN 1 AND 256 OR
     COALESCE(jsonb_typeof(authority->'reason') <> 'string', TRUE) OR
     length(btrim(COALESCE(authority->>'reason', ''))) NOT BETWEEN 1 AND 1024 OR
     COALESCE(jsonb_typeof(authority->'committedAt') <> 'string', TRUE) OR
     NOT (authority->>'committedAt' ~
       '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$') THEN
    RETURN FALSE;
  END IF;
  BEGIN
    parsed_committed_at := (authority->>'committedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN FALSE;
  END;
  IF parsed_committed_at IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$function$;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_cancellation_authority_shape CHECK (
    validate_ticket_cancellation_authority_shape(cancellation_authority, id) IS TRUE
  );

CREATE FUNCTION enforce_ticket_cancellation_authority_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.cancellation_authority IS NOT NULL AND
     NEW.cancellation_authority IS DISTINCT FROM OLD.cancellation_authority THEN
    RAISE EXCEPTION 'Ticket cancellation authority is immutable once committed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER tickets_cancellation_authority_immutable
BEFORE UPDATE ON tickets
FOR EACH ROW EXECUTE FUNCTION enforce_ticket_cancellation_authority_immutability();
