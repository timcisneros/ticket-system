# Suppression Recovery Inventory

All `action.suppressed` events catalogued with the model's next response.

## Classification Key

| Label | Definition |
|---|---|
| **legal retry** | Next step proposes ≤limit mutating actions |
| **inspection** | Next step proposes only listDirectory/readFile |
| **abandonment** | Next step has no actions (stall) |
| **reduced batch (bundle)** | Next step has >limit mutations but matches `isAllowedFolderWriteBundle` exception |
| **run ended** | No next step — run terminated before next model response |

## Full Inventory (18 suppression events)

### COMPLETED RUNS — model recovered

| Run | Step | Proposed Actions | Count | Limit | Next Response | Classification |
|-----|------|-----------------|:----:|:-----:|--------------|:---:|
| 1 | 0 | createFolder, writeFile, writeFile | 3 | 2 | createFolder, writeFile | legal retry |
| 2 | 0 | createFolder, writeFile, writeFile | 3 | 2 | createFolder, writeFile | legal retry |
| 2 | 0 | createFolder, writeFile, writeFile | 3 | 2 | createFolder, writeFile | legal retry |
| 3 | 0 | createFolder, createFolder, createFolder | 3 | 2 | createFolder, createFolder | legal retry |
| 105 | 0 | createFolder, writeFile, writeFile, writeFile | 4 | 2 | createFolder, writeFile, writeFile | **reduced batch (bundle)** |

### FAILED RUNS — model did not recover

| Run | Step | Proposed Actions | Count | Limit | Next Response | Classification | Terminal Cause |
|-----|------|-----------------|:----:|:-----:|--------------|:---:|:---|
| 92 | 1 | deletePath × 8 | 8 | 2 | listDirectory | inspection | step limit |
| 165 | 2 | createFolder, renamePath, renamePath | 3 | 2 | listDirectory | inspection | no-progress |
| 166 | 2 | createFolder, renamePath, renamePath | 3 | 2 | listDirectory | inspection | no-progress |
| 168 | 2 | createFolder, renamePath, renamePath | 3 | 2 | listDirectory | inspection | no-progress |
| 169 | 2 | createFolder, renamePath, renamePath | 3 | 2 | listDirectory | inspection | no-progress |
| 170 | 2 | createFolder, renamePath, renamePath | 3 | 2 | listDirectory | inspection | no-progress |
| 171 | 2 | createFolder, renamePath, renamePath | 3 | 2 | listDirectory | inspection | no-progress |
| 172 | 2 | createFolder, renamePath × 3 | 4 | 3 | listDirectory | inspection | no-progress |
| 173 | 2 | createFolder, renamePath × 3 | 4 | 3 | listDirectory | inspection | no-progress |
| 174 | 2 | createFolder, renamePath × 3 | 4 | 3 | listDirectory | inspection | no-progress |
| 175 | 2 | createFolder, renamePath × 3 | 4 | 3 | listDirectory | inspection | no-progress |
| 176 | 2 | createFolder, renamePath × 3 | 4 | 3 | listDirectory | inspection | no-progress |
| 177 | 2 | createFolder, renamePath × 5 | 6 | 3 | listDirectory | inspection | no-progress |

## Classification Summary

| Recovery Pattern | Count | Runs | Terminal Outcomes |
|:---|---:|------|:---:|
| **legal retry** | 4 | 1, 2, 2, 3 | 100% completed |
| **reduced batch (bundle)** | 1 | 105 | completed |
| **inspection (recovery failed)** | 13 | 92, 165-171, 172-177 | 13/13 failed |
| **abandonment** | 0 | — | — |

## Which Pattern is General?

**A: The "Run 165 style" pattern (suppression → inspection → death) is dominant across the entire system.**

13 of 18 suppression events (72%) were followed by the model reverting to inspection. All 13 were terminal.

**B: The "legal retry" pattern occurred only in the earliest runs (1, 2, 3).**

All 4 successful recoveries were in the first 3 runs executed — all using `createFolder + writeFile` actions (not `renamePath`). These runs were early validation tickets, likely with simpler prompts.

Run 105 is an outlier: 4→3 reduction still above limit but matched the bundle exception, so it was never suppressed.

## Key Finding

The model's recovery behavior changed after the first 3 runs. Every suppression from Run 92 onward was followed by inspection (13/13). No model has successfully retried with a smaller legal batch since the first 3 runs of the system.

This suggests recovery failure is not Run 165-specific but is the **general behavior** of the model when confronted with suppression feedback. The first 3 runs were different — possibly because their prompts/contexts were simpler or their action patterns (createFolder + writeFile) were easier to bisect.
