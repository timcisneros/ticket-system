DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM runs LIMIT 1) THEN
    RAISE EXCEPTION '013_run_phase_projection requires an empty development run store; reset disposable PostgreSQL foundation data';
  END IF;
END;
$block$;

ALTER TABLE runs
  ADD COLUMN current_phase TEXT NOT NULL DEFAULT 'planning',
  ADD CONSTRAINT runs_current_phase_check CHECK (
    current_phase IN ('planning', 'inspection', 'mutation', 'verification', 'terminalization')
  ),
  ADD CONSTRAINT runs_terminal_phase_shape CHECK (
    status NOT IN ('completed', 'failed', 'interrupted') OR current_phase = 'terminalization'
  );
