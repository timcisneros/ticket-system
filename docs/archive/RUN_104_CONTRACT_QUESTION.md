# Run 104 Contract Question

## Question

Are workspace operation failures intended to be:

A. terminal  
B. recoverable  
C. category-dependent

## Answer

**No consistent contract exists.** The documentation and code contradict each other.

---

## Evidence from Documentation

### OPERATIONS.md (line 382-384)

> 4. **The runtime surfaces errors truthfully** — if a write fails (ENOENT, ownership violation, protected path), the model sees the error and can recover

This statement appears in the "How it works" subsection of "Optimistic Execution Guidance" (section 8). It explicitly claims that workspace operation failures are **recoverable** — the model "sees the error and can recover."

### STATE_SURFACES.md (line 364, 367)

> `oquery failures --recoverable` → errors the model could self-correct with better feedback

> The "recoverable" flag is deterministic: true if the model could fix the action shape in a subsequent step with corrective feedback.

This describes a proposed failure surface where some errors are classified as recoverable because the model could fix them "in a subsequent step." This presumes the model receives the error and gets a subsequent step.

---

## Evidence from Code

### `server.js:7697-7706` (renamePath execution)

```javascript
try {
  result = runWorkspaceProvider.rename(pathValue, nextPath);
  // ...
} catch (error) {
  // ... records history ...
  throw error;  // re-thrown
}
```

### `server.js:8970-9014` (action loop catch block)

```javascript
} catch (error) {
  // ... records replay snapshot and event ...
  error.workspaceAction = error.workspaceAction || action;
  throw error;  // re-thrown to main loop
}
```

### `server.js:9107-9109` (main loop catch)

```javascript
} catch (error) {
  // ...
  run = failAgentRun(run, error.message, error);
  // ...
}
```

### Code finding

Filesystem errors from `renamePath`, `writeFile`, `createFolder`, `deletePath`, and `readFile` are:
1. Caught inside `executeWorkspaceOperation`
2. Recorded in operation history
3. Re-thrown to the action loop
4. Recorded in replay snapshot and events
5. Re-thrown to the main loop
6. Caught by `failAgentRun`, which terminalizes the run

The model **never receives the error as feedback**. The run ends immediately.

The **only** filesystem error handled gracefully is `listDirectory` ENOENT (`server.js:7527-7532`), which returns `{status: 'not_found', entries: []}` to the model instead of throwing.

---

## Conclusion

**No contract exists that is consistent between documentation and implementation.**

| Source | Claim |
|--------|-------|
| OPERATIONS.md | "The model sees the error and can recover" — **recoverable** |
| STATE_SURFACES.md | "The model could fix [it] in a subsequent step" — **recoverable** |
| server.js implementation | All filesystem errors (except `listDirectory` ENOENT) are catch-record-rethrow-terminalize — **terminal** |

The documentation claims **B. recoverable**. The code implements **A. terminal**. No document defines **C. category-dependent** boundaries (e.g., which error types are terminal vs recoverable). No document reconciles the contradiction.

**Narrowest statement:** A contract is claimed in operator guidance documents but not implemented in the runtime. Therefore, no enforceable contract exists.

---

*Document generated from inspection of OPERATIONS.md, STATE_SURFACES.md, and server.js lines 7527-7532, 7663-7712, 7697-7706, 8820-9014, 9107-9109 on 2026-05-28.*
