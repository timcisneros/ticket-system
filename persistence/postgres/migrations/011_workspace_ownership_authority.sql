-- Indexed, immutable projections used by workspace mutation admission.
-- The operation receipt remains the evidence authority; these columns avoid
-- reinterpreting or scanning receipt JSON while a hierarchical target lock is held.

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM operation_receipts LIMIT 1) THEN
    RAISE EXCEPTION
      'workspace ownership projection migration requires an empty development operation receipt store; reset disposable development data before cutover';
  END IF;
END;
$migration$;

ALTER TABLE operation_receipts
  ADD COLUMN workspace_path TEXT,
  ADD COLUMN artifact_path TEXT,
  ADD COLUMN mutation_fingerprint TEXT;

ALTER TABLE operation_receipts
  ADD CONSTRAINT operation_receipts_workspace_projection_shape CHECK (
    (workspace_path IS NULL AND artifact_path IS NULL AND mutation_fingerprint IS NULL)
    OR
    (workspace_path IS NOT NULL AND length(workspace_path) > 0
      AND mutation_fingerprint IS NOT NULL AND length(mutation_fingerprint) > 0
      AND (artifact_path IS NULL OR length(artifact_path) > 0))
  );

CREATE INDEX operation_receipts_workspace_conflict_idx
  ON operation_receipts (run_id, target_id, workspace_path, id)
  WHERE workspace_path IS NOT NULL;

CREATE INDEX operation_receipts_artifact_owner_exact_idx
  ON operation_receipts (target_id, artifact_path, id)
  WHERE outcome = 'succeeded' AND artifact_path IS NOT NULL;

CREATE INDEX operation_receipts_artifact_owner_prefix_idx
  ON operation_receipts (target_id, artifact_path text_pattern_ops, id)
  WHERE outcome = 'succeeded' AND artifact_path IS NOT NULL;
