-- Quality scoring reads only successful workspace mutation evidence. Keep that
-- per-run lookup bounded to the relevant append-only receipt subset without
-- copying evidence into a second analytics store.
CREATE INDEX operation_receipts_run_performance_evidence_idx
  ON operation_receipts (run_id, id)
  WHERE outcome = 'succeeded'
    AND operation IN ('writeFile', 'createFolder', 'renamePath', 'deletePath');
