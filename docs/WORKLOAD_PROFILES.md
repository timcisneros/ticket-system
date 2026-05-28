# Workload Profiles

## Overview

The runtime assigns an explicit operational envelope (workload profile) to each ticket based on its objective. Profiles define step limits, model request limits, operation budgets, allowed operation mixes, and prompt guidance tailored to the ticket class.

## Profile Selection

Profiles are detected from the ticket objective using keyword matching. Detection is ordered:

1. `diagnosis` — diagnose, bug, failing test, incorrect assertion
2. `refactor` — move, rename, restructure, refactor, archive files/folders
3. `recommendation` — recommend, top N, improvement, critical issue, action item
4. `bulk-inventory` — list all, catalog, inventory, enumerate, all files
5. `report` — report, summary, analysis, status, audit (catch-all)

If no profile matches, the runtime falls back to the base limit set.

## Profiles

### 1. Report

**Description:** Inspection-heavy task producing a summary or analysis document.

**Operational Envelope:**
- `executionStepLimit`: 12
- `modelRequestLimit`: 8
- `maxWorkspaceOperations`: 32
- `maxListDirectory`: 3
- `maxReadFile`: 8

**Allowed Operations:** `listDirectory`, `readFile`, `writeFile`, `createFolder`

**Final Artifact Required:** Yes (one `writeFile` with the report)

**Expected Phase Pattern:** planning → inspection → mutation

**Prompt Guidance:**
- Cite specific file paths inspected
- Do not invent file contents
- Do not create multiple report files

**Retry Guidance:** Simplify objective to target fewer directories. Avoid listing subdirectories individually.

**Observed Failure Mode:** Run #60 failed because the objective asked to "list all files in subdirectories separately," exceeding the 3 listDirectory limit. The retry with a simplified objective succeeded.

---

### 2. Diagnosis

**Description:** Read files to identify bugs, test failures, or incorrect behavior.

**Operational Envelope:**
- `executionStepLimit`: 12
- `modelRequestLimit`: 8
- `maxWorkspaceOperations`: 24
- `maxListDirectory`: 2
- `maxReadFile`: 6

**Allowed Operations:** `listDirectory`, `readFile`, `writeFile`, `createFolder`

**Final Artifact Required:** Yes (diagnosis document)

**Expected Phase Pattern:** planning → inspection → mutation

**Prompt Guidance:**
- Focus on identifying the root cause of the bug or test failure
- Explain why each identified assertion is incorrect with evidence from the source code

**Retry Guidance:** Specify exact file paths to inspect. Avoid broad workspace scans.

**Observed Failure Mode:** Run #61 (Mike/gemma3) failed due to Ollama OOM. Retry with Agent 1 succeeded.

---

### 3. Refactor

**Description:** Move, rename, or restructure files and folders.

**Operational Envelope:**
- `executionStepLimit`: 12
- `modelRequestLimit`: 8
- `maxWorkspaceOperations`: 24
- `maxListDirectory`: 2
- `maxReadFile`: 4

**Allowed Operations:** `listDirectory`, `readFile`, `renamePath`, `createFolder`, `deletePath`

**Final Artifact Required:** No (workspace state change is the outcome)

**Expected Phase Pattern:** planning → inspection → mutation → verification

**Prompt Guidance:**
- **Phase 1 — DISCOVER:** `listDirectory` the relevant directory **once**. Identify every item that must be moved, renamed, or created. Do not list again in later steps.
- **Phase 2 — PLAN:** State in your message the exact `renamePath` and `createFolder` operations you will perform. Do not perform them yet.
- **Phase 3 — MUTATE:** In one response, perform all required `createFolder` and `renamePath` operations. Use exact source and destination paths.
- **Phase 4 — VERIFY:** `listDirectory` the affected directories to confirm items are in the correct locations. Check that no items remain at old locations.
- **Phase 5 — COMPLETE:** Set `complete:true` only after verification succeeds.
- If no matching items exist at the source, state this clearly and complete after any required `createFolder` operations.
- If an item cannot be moved, fail with an explicit reason. Do not enter a loop of repeated `listDirectory` calls.

**Retry Guidance:** Name exact source files and destination paths. Do not use "all files" phrasing.

**Observed Failure Mode:**
- Run #64: agent created archive/, moved one file, then got stuck in repeated `listDirectory` loops. Failed for non-progress.
- Run #69: agent created folders A and B, then repeated `listDirectory` without performing any `renamePath`. Failed for non-progress.
- Retry with exact file names or following the 5-phase progression succeeds in 2–3 steps.

---

### 4. Recommendation

**Description:** Read files and produce an evidence-based improvement plan.

**Operational Envelope:**
- `executionStepLimit`: 12
- `modelRequestLimit`: 8
- `maxWorkspaceOperations`: 24
- `maxListDirectory`: 2
- `maxReadFile`: 6

**Allowed Operations:** `listDirectory`, `readFile`, `writeFile`, `createFolder`

**Final Artifact Required:** Yes (recommendation document)

**Expected Phase Pattern:** planning → inspection → mutation

**Prompt Guidance:**
- Prioritize the most critical issues. Do not list every minor improvement.
- Link each recommendation to specific evidence from the inspected files.

**Retry Guidance:** Limit scope to top N issues. Specify exact files to analyze.

**Observed Failure Mode:** Run #63 (Mike/gemma3) failed due to Ollama OOM. Retry with Agent 1 succeeded.

---

### 5. Bulk Inventory

**Description:** List and catalog many directories or files across the workspace.

**Operational Envelope:**
- `executionStepLimit`: 16
- `modelRequestLimit`: 10
- `maxWorkspaceOperations`: 40
- `maxListDirectory`: 8
- `maxReadFile`: 4

**Allowed Operations:** `listDirectory`, `readFile`, `writeFile`, `createFolder`

**Final Artifact Required:** Yes (inventory summary document)

**Expected Phase Pattern:** planning → inspection → mutation

**Prompt Guidance:**
- Avoid listing every subdirectory individually. Group related paths when possible.
- Produce one summary `writeFile` with the inventory results.

**Retry Guidance:** Break into smaller inventory scopes. Do not list every subdirectory individually.

**Observed Failure Mode:** None yet. This profile was created specifically to address the Run #60 failure where a multi-directory inventory exceeded the report listDirectory limit of 3.

---

## Runtime Integration

### Detection
The `detectWorkloadProfile(objective)` function inspects the ticket objective and returns the matching profile name or `null`.

### Limits
The `getProfileRuntimeLimits(baseLimits, profileName)` function applies the profile envelope, capping each limit to the smaller of the base or profile value. This ensures profiles never exceed globally configured limits.

### Prompt Guidance
The `buildProfileGuidance(objective)` function generates profile-specific lines that are injected into the system prompt. The model sees:
- The profile name and description
- The exact listDirectory and readFile limits
- The expected phase pattern
- Class-specific guidance (e.g., "cite specific file paths" for reports)

### Runtime Envelope
The profile name is exposed in `runtimeEnvelope.workloadProfile` so the model knows which operational envelope it is running under.

## Invariants

1. Every ticket gets either a profile envelope or the base limit set — no ticket runs without limits.
2. Profile limits never exceed base limits (capped at `Math.min`).
3. Profile guidance is injected into the system prompt, not hidden from the model.
4. Profile detection is deterministic (same objective → same profile).
5. Profile failure modes are documented with retry guidance.
