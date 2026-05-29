# Documentation-Implementation Divergence

## Subject

Workspace operation error handling: claimed behavior vs implemented behavior.

---

## 1. Claimed Behavior

### Claim A: "The model sees the error and can recover"

**Source:** `OPERATIONS.md`, section 8 "Optimistic Execution Guidance", subsection "How it works", step 4.

**Exact text:**
> 4. **The runtime surfaces errors truthfully** — if a write fails (ENOENT, ownership violation, protected path), the model sees the error and can recover

**Nature of claim:** Workspace operation failures (write failures, ownership violations, protected path blocks) are returned to the model as feedback, allowing the model to adapt and continue.

**Earliest document containing claim:** `OPERATIONS.md` in commit `e1f4189` (initial commit, 2026-05-19).

### Claim B: "Errors the model could self-correct with better feedback"

**Source:** `STATE_SURFACES.md`, Surface 7: Failure Context State.

**Exact text:**
> - `oquery failures --recoverable` → errors the model could self-correct with better feedback
> The "recoverable" flag is deterministic: true if the model could fix the action shape in a subsequent step with corrective feedback.

**Nature of claim:** Some failures are classified as "recoverable" because the model could fix them "in a subsequent step with corrective feedback." This presumes the model receives the error and gets another step.

**Earliest document containing claim:** `STATE_SURFACES.md` in commit `23a7594` (pressure testing results and updates, 2026-05-20).

---

## 2. Implemented Behavior

### Implementation: Catch-record-rethrow-terminalize

**Code location:** `server.js`

**Pattern:**

1. `executeWorkspaceOperation` catches filesystem errors, records them in operation history, and re-throws them (`server.js:7697-7706`, `server.js:7649-7660`, `server.js:7751-7756`).
2. The action loop catches the error, records it in `actionResults` and replay snapshot/events, then re-throws it (`server.js:8970-9014`).
3. The main loop catches the error and calls `failAgentRun`, which terminalizes the run (`server.js:9107-9109`).

**Result:** The model never receives the error as feedback. The run ends immediately.

**Exception:** `listDirectory` ENOENT (`server.js:7527-7532`) is the only filesystem error handled gracefully — it returns `{status: 'not_found', entries: []}` to the model instead of throwing.

**Earliest implementation exhibiting behavior:** Commit `e1f4189` (initial commit, 2026-05-19). Both `actionResults.push({ action, error: error.message })` and the subsequent `throw error` were present in the initial `server.js`.

---

## 3. Evidence for Each

### Documentation Evidence

| Document | Commit | Date | Claim |
|----------|--------|------|-------|
| `OPERATIONS.md` | `e1f4189` | 2026-05-19 | "The runtime surfaces errors truthfully — if a write fails (ENOENT, ownership violation, protected path), the model sees the error and can recover" |
| `STATE_SURFACES.md` | `23a7594` | 2026-05-20 | "The 'recoverable' flag is deterministic: true if the model could fix the action shape in a subsequent step with corrective feedback" |

### Implementation Evidence

| Code Location | Commit | Date | Behavior |
|---------------|--------|------|----------|
| `server.js:8970-9014` (action loop catch) | `e1f4189` | 2026-05-19 | `actionResults.push({ action, error: error.message })` followed by `throw error` |
| `server.js:7697-7706` (renamePath catch) | `e1f4189` | 2026-05-19 | Records history, then `throw error` |
| `server.js:9107-9109` (main loop catch) | `e1f4189` | 2026-05-19 | `failAgentRun(run, error.message, error)` — terminalizes |
| `server.js:7527-7532` (listDirectory ENOENT) | `e1f4189` | 2026-05-19 | Returns `not_found` result to model instead of throwing |

---

## 4. Determination

### Is this accidental drift?

**No.** Both the documentation claim and the implementation behavior were present in the initial commit (`e1f4189`, 2026-05-19). The divergence did not emerge over time; it existed from the first commit.

### Is this an undocumented design change?

**No.** There is no evidence of a design change. The implementation behavior has not changed since the initial commit. The documentation claim has not been modified to align with the implementation, nor has the implementation been modified to align with the documentation.

### Is this an unresolved inconsistency?

**Yes.** The documentation explicitly claims that workspace operation failures are recoverable feedback. The implementation silently treats all filesystem errors (except `listDirectory` ENOENT) as terminal failures. Both claims and behaviors have co-existed since 2026-05-19 without reconciliation.

---

## 5. Narrowest Statement

The documentation claims workspace operation errors are recoverable feedback. The implementation treats them as terminal failures. Both were present in the initial commit on 2026-05-19. The divergence is an **unresolved inconsistency** that has existed since the project's inception.

---

*Document generated from inspection of `OPERATIONS.md`, `STATE_SURFACES.md`, and `server.js` via git history (commits `e1f4189` and `23a7594`) on 2026-05-28.*
