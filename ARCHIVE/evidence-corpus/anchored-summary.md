# Terminal Path Classification Against Adopted Ordering (Truthfulness > Boundedness)

## A. Boundedness — Resource/step/operation budget exhausted, unconditional terminal

| # | Location | Trigger | Evidence |
|---|----------|---------|----------|
| 1 | L8491 | `assertRunNotTimedOut` — `elapsedMs > maxRuntimeDurationMs` | `createRunLimitError` (L4305): code `RUN_LIMIT_EXCEEDED`, limitType `timeout`, **no failureKind** |
| 2 | L8492 | `assertRunStepAllowed` — `currentStep >= maxExecutionSteps` | Same constructor, limitType `step`, no failureKind |
| 3 | L8493 | `assertRunModelRequestAllowed` — `currentCount >= maxModelRequestsPerRun` | Same constructor, limitType `model_request`, no failureKind |
| 4 | L8740 | `assertRunWorkspaceOperationAllowed` — `nextCount > maxWorkspaceOperationsPerRun` | Same constructor, limitType `operation`, no failureKind |
| 5 | L8760 | `listDirectoryCount > maxListDirectoryPerRun` | Same constructor, limitType `operation`, no failureKind, inside innermost try → gate L8934 |
| 6 | L8769 | `readFileCount > maxReadFilePerRun` | Same constructor, limitType `operation`, no failureKind, inside innermost try → gate L8934 |

**Pattern**: All use `createRunLimitError` which sets NO `failureKind`. At gate L8934 `undefined !== 'workspace_error'` → re-thrown. These are configured numeric budgets. No model-warning mechanism exists — first violation is terminal.

**Count: 6 terminal paths**

---

## B. Security — Authority boundary or safety constraint violated

| # | Location | Trigger | Evidence |
|---|----------|---------|----------|
| 7 | L4930 | `checkWorkspaceMutationAuthority` — `lease_owner` rule: current process does not hold lease | `createAuthorityDeniedError`: code `RUN_LEASE_REQUIRED`, **no failureKind** |
| 8 | L4938 | same function — `protected_path` rule: path matches protected pattern | `createAuthorityDeniedError`: code `WORKSPACE_PROTECTED_PATH`, **no failureKind** |
| 9 | L4951 | same function — `owned_output_path` rule: mutation outside owned scope | `createAuthorityDeniedError`: code `WORKSPACE_OWNERSHIP_VIOLATION`, **no failureKind** |
| 10 | L4851 | `assertAllocatedOwnershipAllowsMutation` → `blockWorkspaceOwnershipViolation` | Same `WORKSPACE_OWNERSHIP_VIOLATION`, no failureKind |
| 11 | L5046 | `assertAgentOperationAllowed` — operation disabled by agent `runtimeConfig` | `AGENT_OPERATION_DISABLED`, failureKind `invalid_action` |
| 12 | L6080 | `assertAgentWorkspacePathAllowed` — path matches sensitive app data paths | `createStructuredWorkspaceError`: code `WORKSPACE_SENSITIVE_PATH`, failureKind `protected_path` |
| 13 | L9081 | `normalizeRelative` — path resolves outside workspace root | `createStructuredWorkspaceError`: code `WORKSPACE_OUTSIDE_ROOT`, failureKind `protected_path` |
| 14 | L9091 | `normalizeRelative` — absolute path | `createStructuredWorkspaceError`: code `WORKSPACE_ABSOLUTE_PATH`, failureKind `protected_path` |
| 15 | L9101 | `normalizeRelative` — `../` path traversal | `createStructuredWorkspaceError`: code `WORKSPACE_PATH_TRAVERSAL`, failureKind `protected_path` |
| 16 | L9107 | `normalizeRelative` — hidden/system path leading dot | `createStructuredWorkspaceError`: code `WORKSPACE_HIDDEN_PATH`, failureKind `protected_path` |

**Pattern**: `createAuthorityDeniedError` (L4881) and `createProtectedWorkspaceError` (L6546) set `code` but **never set `failureKind`**. The `createStructuredWorkspaceError` paths set `failureKind: 'protected_path'` which the gate also rejects. All 10 enter the gate at L8934 with `failureKind !== 'workspace_error'` → re-thrown.

**Count: 10 terminal paths**

---

## C. Implementation Convenience — Runtime could report error to model and continue, but doesn't

| # | Location | Trigger | Evidence |
|---|----------|---------|----------|
| 17 | L8395 | Ticket executionMode `workflow` but workflow not found or disabled | `WORKFLOW_NOT_AVAILABLE`, failureKind `invalid_action`, direct throw to outer catch. No model could fix this — it's a config issue — but the runtime could fall back to agent mode. |
| 18 | L8564 | `parseModelActions` returns `parseError` — model response is not valid JSON | `MODEL_MALFORMED_JSON`, failureKind `invalid_action`. First bad response is terminal. No retry mechanism. |
| 19 | L6689 | `parseAgentDirectAction` — action is not an object | `AGENT_ACTION_MALFORMED`, **no failureKind**. Gate L8934. Could report specific parse error to model. |
| 20 | L6720 | `parseAgentDirectAction` — `createWorkflowDraft` args.workflow is not object | `WORKFLOW_DRAFT_INVALID`, **no failureKind**. Gate L8934. Could report validation error. |
| 21 | L6656 | `parseWorkspaceOperation` — action not object/missing op/invalid args | `WORKSPACE_MALFORMED_ACTION`, **no failureKind**. Gate L8934. Could report specific error. |
| 22 | L6670 | `parseWorkspaceOperation` — operation not in `AGENT_ALLOWED_OPERATIONS` | `WORKSPACE_UNSUPPORTED_OPERATION`, **no failureKind**. Gate L8934. Could report allowed list. |
| 23 | L9190 | `readFile` — path exists but is not a file (directory) | bare `new Error("Path is not a file")`, **no failureKind**. Gate L8934. Could report to model. |
| 24 | L9205 | `writeFile` — path exists but is not a file (directory) | bare `new Error("Path is not a file")`, **no failureKind**. Gate L8934. Same. |
| 25 | L9261 | `rename` — source path does not exist | bare `new Error("Path does not exist")`, **no failureKind**. Gate L8934. |
| 26 | L9265 | `rename` — destination already exists | bare `new Error("Destination already exists")`, **no failureKind**. Gate L8934. |
| 27 | L9277 | `delete` — path is workspace root | bare `new Error("Cannot delete workspace root")`, **no failureKind**. Gate L8934. |
| 28 | L7504 | `executeWorkspaceOperation` — conflicting mutation already committed on same path | `MUTATION_CONFLICT`, **no failureKind**. Gate L8934. |
| 29 | L7451 | `listDirectory` catch — non-ENOENT OS error (EACCES, etc.) | Original error re-thrown, **no failureKind** on underlying error. Gate L8934. |
| 30 | L9196/L9215/L9251 | `createStructuredWorkspaceFsError` non-ENOENT passthrough — EACCES, EISDIR, etc. | Non-ENOENT errors pass through `createStructuredWorkspaceFsError` unchanged. No failureKind. Gate L8934. |

**Pattern**: Every path in category C has the same structural property — the error reaches the action-level catch (L8890), `error.failureKind` is either `undefined` or `'invalid_action'` or `'protected_path'`, and the gate (L8934) re-throws because none of these equal `'workspace_error'`. In every case, the runtime **could** have assigned `failureKind: 'workspace_error'` to make the error non-terminal, appended the specific error to `actionResults`, and let the model retry the action with corrected input. The absence of this assignment is a design choice, not a structural necessity.

**Count: 14 terminal paths**

---

## D. Truthfulness Protection — Model behavior or state integrity requires termination

| # | Location | Trigger | Evidence |
|---|----------|---------|----------|
| 31 | L8459 | Resume: duplicate mutation or broken hash chain | `RUN_RESUME_UNSAFE`, failureKind `resume_rejected`. Execution state is corrupted — runtime cannot trust the recorded event ledger. |
| 32 | L8475 | Resume: committed mutations without authority records | `RUN_RESUME_UNSAFE`, failureKind `resume_rejected`. Authority chain is missing — runtime cannot verify whether past mutations were authorized. |
| 33 | L8714 | Model returned `complete: false` with zero actions AND `isUnsupportedObjectiveModelPlan` is true | `unsupported_objective`, failureKind `unsupported_objective`. Model truthfully declares objective impossible. Runtime accepts the truthful assessment and terminates. |
| 34 | L8721 | Model returned `complete: false` with zero actions (not unsupported), ≥2 times | `createRunLimitError` (no failureKind). First stall warned ("emit or complete"). Second stall: model neither acts nor completes — not truthfully engaging. |
| 35 | L8651 | Model exceeded `MAX_MUTATING_ACTIONS_PER_RESPONSE` on ≥2 consecutive responses (same signature) | `createRunLimitError` + `failureKind = 'invalid_action'`. First violation warned ("exceeded limit, retry with ≤3 mutating actions"). Second violation: model ignored feedback. |
| 36 | L9000 | Model produced inspection-only actions (listDirectory/readFile) without any mutation, ≥3 steps | `createRunLimitError` + `failureKind = 'no_progress'`. ≥2 warned ("bounded inspection must be followed by bounded operation batch"). ≥3: model ignored feedback. |
| 37 | L6703 | `parseAgentDirectAction` — operation not in `AGENT_DIRECT_OPERATIONS` | `AGENT_ACTION_UNSUPPORTED`, **no failureKind** → gate L8934. Model fabricating operations not in prompt. |
| 38 | L8577 | `isRunInterrupted` — run status externally set to 'interrupted' (pre-action) | `RUN_INTERRUPTED`, no failureKind. Direct throw to outer catch. Runtime honors external state. |
| 39 | L8747 | `isRunInterrupted` — same check inside innermost try (in-action safety net) | `RUN_INTERRUPTED`, no failureKind → gate L8934. Same. |

**Pattern**: Paths 33-36 share a design — first behavioral violation produces a structured warning in `actionResults`, the step continues, and the model is told exactly what to do differently. Only the **repeated violation** is terminal. Paths 31-32 are state integrity — no model behavior can fix corrupted execution state. Path 37 is immediate terminal (no warning step) because the operation doesn't exist to execute. Paths 38-39 are externally driven.

**Count: 9 terminal paths**

---

## Summary Table

| Category | Count | Design Pattern |
|----------|-------|----------------|
| **A. Boundedness** | 6 | `createRunLimitError` (no failureKind) → first violation terminal |
| **B. Security** | 10 | Authority errors (no failureKind or `protected_path`) → gate L8934 terminal |
| **C. Implementation Convenience** | 14 | Errors with no `workspace_error` mapping → gate L8934 terminal |
| **D. Truthfulness Protection** | 9 | Behavioral violations warned then terminated; state integrity; unsupported ops |

**Total terminal paths: 39**

Non-terminal (recoverable) action-level errors: **2 codes** — `WORKSPACE_FS_ENOENT` (ENOENT on readFile/writeFile/createFolder) and `WORKSPACE_PATH_TYPE_CONFLICT` (createFolder on existing non-directory). Both have `failureKind: 'workspace_error'`, the only value the gate (L8934) accepts.

---

## Key Observation for Adopted Ordering

The adopted ordering states **Truthfulness > Boundedness**. In the current runtime:

- **Boundedness paths (6)** are unconditional — no truthfulness-based override exists. Step/timeout/model/operation limits terminate immediately regardless of model truthfulness.

- **Truthfulness protection paths (9)** include 4 with a warning-then-terminate pattern (stalled, mutating action limit, no-progress). These already implement the ordering: truthfulness feedback is given before boundedness termination.

- **Implementation convenience paths (14)** are the largest category. They are terminal not because of truthfulness or boundedness, but because no engineer assigned `failureKind: 'workspace_error'` to those error paths. These 14 paths are where the untraced policy lives — they're terminal by omission, not by design.
