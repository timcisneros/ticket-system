# Batch Workload Validation Report

Generated: 2026-05-28T

## Summary

| Case | Status | Model Requests | Workspace Ops | Verification Failures | Phase Violations | No-Progress Events | Contract |
|------|--------|---------------|--------------|----------------------|------------------|-------------------|----------|
| ab-folder-org | completed | 4 | 5 | 0 | 0 | 0 | PASS |
| archive-txt | completed | 4 | 5 | 0 | 0 | 0 | PASS |

## Detailed Results

### ab-folder-org

- **Status:** completed
- **Model Requests:** 4
- **Workspace Operations:** 5
- **Verification Failures:** 0
- **Phase Violations:** 0
- **No-Progress Events:** 0
- **Contract:** PASS

### archive-txt

- **Status:** completed
- **Model Requests:** 4
- **Workspace Operations:** 5
- **Verification Failures:** 0
- **Phase Violations:** 0
- **No-Progress Events:** 0
- **Contract:** PASS

## Validation Criteria

1. **Inspects once**: First model request contains only inspection operations (listDirectory/readFile)
2. **Emits mutation batch**: At least one request contains only mutation operations (createFolder, writeFile, renamePath, deletePath)
3. **No repeated inspection**: No more than 1 inspection-only response (more would trigger no_progress)
4. **No phase violations**: No mixed-phase responses (inspection + mutation in same request)
5. **Structural verification**: Zero batch.verification_failed events (runtime verifies without model re-entry)
6. **Workspace state correct**: Final filesystem state matches expected outcome

## Plan Designs

Both plans were designed to respect runtime limits:
- `maxExecutionSteps` = 4 (4 model responses max)
- `maxListDirectoryPerRun` = 2 (only 1 listDirectory used)
- `maxMutatingActionsPerResponse` = 2 (exactly 2 mutations per batch)

### ab-folder-org plan
1. listDirectory "" (inspect)
2. createFolder A, createFolder B (mutation batch)
3. renamePath Alpha→A/Alpha, renamePath Beta→B/Beta (mutation batch)
4. complete

### archive-txt plan
1. listDirectory "" (inspect)
2. createFolder archive, renamePath a.txt→archive/a.txt (mutation batch)
3. renamePath b.txt→archive/b.txt, renamePath d.txt→archive/d.txt (mutation batch)
4. complete

## Conclusion

- **Passed:** 2/2
- **Failed:** 0/2

Both bounded operation batch workloads passed validation within runtime limits.
