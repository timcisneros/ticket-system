# Run 104 Failure Review

## Question

Was Run 104 primarily:

A. model failure  
B. runtime failure  
C. substrate failure  
D. mixed failure

---

## Evidence

### 1. Why did the model emit `renamePath(B, B)`?

**Replay snapshot (`data/replay-snapshots/run-104.json`):**

Step 1 model response:
```json
{
  "message": "Create folders A and B if missing and move folders starting with A or B (except A and B) into these folders.",
  "actions": [
    {"operation": "renamePath", "args": {"path": "archive", "nextPath": "A/archive"}},
    {"operation": "renamePath", "args": {"path": "B", "nextPath": "B"}}
  ],
  "complete": false
}
```

**Observation:** The model was instructed:
> "Do not move folders named exactly A or B."

It proposed:
1. `renamePath archive → A/archive` — incorrect because "archive" starts with lowercase 'a', not uppercase 'A'
2. `renamePath B → B` — a self-rename, which is a no-op and violates the "do not move folders named exactly A or B" rule

The model misunderstood the instruction. It appears to have treated "folders whose name starts with uppercase B" as including the folder "B" itself, then attempted to move it into itself.

---

### 2. Should the runtime have detected self-renames before execution?

**Code inspection — `server.js:7663-7712` (executeWorkspaceOperation for renamePath):**

```javascript
if (operation === 'renamePath') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.renamePath, 'renamePath args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    const nextPath = requireStringArg(args, 'nextPath', { nonEmpty: true });
    checkWorkspaceMutationAuthority(run, operation, { path: pathValue, nextPath });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue, nextPath }, pathValue, runWorkspaceProvider);
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue, nextPath }, nextPath, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue, nextPath }, pathValue, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue, nextPath }, nextPath, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);
    assertAgentWorkspacePathAllowed(nextPath);

    // Skip if already committed in this run's ledger
    // ...
    // Reject if a different mutation already committed on the same path
    // ...

    try {
      result = runWorkspaceProvider.rename(pathValue, nextPath);
      // ...
    } catch (error) {
      // ... records history ...
      throw error;
    }
}
```

**Finding:** The runtime validates:
- Key presence (`path`, `nextPath`)
- Mutation authority
- Ownership scope
- Protected paths
- Agent path rules
- Idempotency (already committed)
- Conflicts (different operation on same path)

**There is no check for `pathValue === nextPath` (self-rename).**

The runtime did not detect the self-rename before handing it to the filesystem provider.

---

### 3. Is a filesystem-level operation error intended to terminate a run immediately?

**Code inspection — `server.js:7697-7706` (renamePath error handling):**

```javascript
try {
  result = runWorkspaceProvider.rename(pathValue, nextPath);
  // ...
} catch (error) {
  const postState = captureWorkspacePostState(...);
  historyRecord = persistWorkspaceOperationHistory(..., null, error);
  if (historyRecord) error.historyId = historyRecord.id;
  throw error;  // re-thrown
}
```

**Code inspection — `server.js:8970-9014` (action loop catch block):**

```javascript
try {
  // ... execute operation ...
} catch (error) {
  const opDurationMs = Date.now() - actionStartedAt;
  actionResults.push({ action, error: error.message });
  if (error.workspaceAction || (operation && AGENT_ALLOWED_OPERATIONS.includes(operation.operation))) {
    // ... records replay snapshot item ...
    appendEvent({ type: 'workspace.operation', ... error info ... });
  }
  error.workspaceAction = error.workspaceAction || action;
  throw error;  // re-thrown again
}
```

**Code inspection — `server.js:9107-9109` (main loop catch):**

```javascript
} catch (error) {
  // ... provider request logging ...
  // ... ultimately calls:
  run = failAgentRun(run, error.message, error);
  // ...
}
```

**Finding:** The filesystem error (`"Destination already exists"`) was:
1. Caught inside `executeWorkspaceOperation`
2. Recorded in operation history
3. Re-thrown to the action loop
4. Caught in the action loop, recorded in replay snapshot and events
5. Re-thrown to the main loop
6. Caught by `failAgentRun`, which terminalized the run

The run never returned control to the model. The model had 2 remaining execution steps and 2 remaining provider requests but was never called again.

---

### 4. Does existing documentation define whether operation errors are recoverable feedback or terminal failures?

**Document search results:**

| Document | Relevant content |
|----------|-------------------|
| `docs/BOUNDED_OPERATION_BATCHES.md` | "Verification failures are recorded as `batch.verification_failed` events. The runtime does not re-enter the model for simple structural verification." This refers to **post-execution verification**, not execution-time filesystem errors. |
| `docs/EXECUTION_SEMANTICS.md` | Defines Resume, Retry, Reassess, and Commit boundaries. Does not define error handling semantics for individual operations. |
| `docs/ARCHITECTURE_INVARIANTS.md` | Invariant #7: "Runtime governs execution semantics." No mention of error classification. |
| `AGENTS.md` | No mention of workspace operation error handling. |
| `docs/EVIDENCE_PRESERVATION_PRINCIPLE.md` | Discusses evidence preservation, not error semantics. |
| `server.js` code comments | None on the catch/re-throw pattern. |

**Finding:** No documented contract defines whether filesystem-level operation errors should be:
- Recoverable feedback (returned to model as actionResults)
- Terminal failures (immediately ending the run)

---

### 5. Comparison with other error types

**Code inspection — protected path errors (`server.js:4836-4853`):**

```javascript
function blockWorkspaceOwnershipViolation(...) {
  // ...
  error.workspaceAction = workspaceAction;  // sets workspaceAction on error
  throw error;  // also throws
}
```

The ownership/protected path errors **also** throw and terminate the run. They differ only in that they attach `error.workspaceAction` metadata for better replay/event recording.

**Code inspection — listDirectory ENOENT (`server.js:7527-7532`):**

```javascript
try {
  result = runWorkspaceProvider.list(pathValue);
} catch (error) {
  if (error.code === 'ENOENT') {
    result = { status: 'not_found', path: pathValue, entries: [] };
  } else {
    throw error;
  }
}
```

**Finding:** `listDirectory` ENOENT is the **only** filesystem error handled gracefully (returns not_found result to model). All other filesystem errors from `readFile`, `createFolder`, `writeFile`, `renamePath`, and `deletePath` are caught, recorded, and re-thrown as terminal failures.

---

## Classification

### Model Behavior

The model proposed `renamePath(B, B)` — a self-rename — and `renamePath(archive, A/archive)` for a folder whose name starts with lowercase 'a'. Both are errors in following instructions.

**Verdict: The model made mistakes.**

### Runtime Behavior

The runtime:
- Did not validate `path !== nextPath` before executing the self-rename
- Treated the resulting filesystem error as a terminal failure, preventing model recovery
- Had 2 remaining execution steps and 2 remaining provider requests when the run was terminated
- This pattern is consistent with how protected_path and ownership errors are handled (also terminal)

**Verdict: The runtime terminated the run after the workspace operation error.**

### Substrate Behavior

The bounded execution loop does not distinguish between:
- Model logic errors (self-rename)
- Environmental errors (destination already exists)
- Authority errors (protected path)

All are treated as fatal exceptions. This is a structural property of the execution loop.

**Verdict: No documented distinction was found between terminal and recoverable workspace operation failures.**

---

## Answer

**D. mixed failure**

### Confidence: High

**Narrowest statement supported by evidence:**

The model proposed a self-rename (`renamePath B → B`) that violated the task instructions. The runtime did not validate the self-rename before execution, and the resulting filesystem error (`"Destination already exists"`) was propagated through two catch-rethrow layers to terminate the run immediately, even though execution budget remained. No documented contract defines whether filesystem errors should be recoverable feedback or terminal failures. The only filesystem error handled gracefully in the codebase is `listDirectory` ENOENT. All other workspace operation errors follow the same catch-record-rethrow-terminalize pattern.

**Model behavior:** The model misunderstood the instructions and proposed an invalid operation.  
**Runtime behavior:** The runtime did not pre-validate the self-rename and terminated the run after the filesystem error.  
**Substrate behavior:** The execution loop treats all operation errors uniformly as fatal exceptions, with no documented distinction between authority violations, environmental failures, and model logic errors.

---

*Document generated from inspection of `data/replay-snapshots/run-104.json`, `data/runs.json`, `data/events.jsonl`, `server.js` lines 7527-7532, 7663-7712, 7697-7706, 8820-9014, 9107-9109, 4836-4853, and design docs on 2026-05-28.*
