# Explicit Operational State Surfaces

> Semantics-definition exercise. Not an implementation plan.
> These surfaces describe what operators repeatedly reconstruct manually.
> The environment should hold truthful operational state.
> The model remains a transient reasoning/runtime process.
> Implemented surfaces are documented in `docs/OPERATIONAL_TELEMETRY.md`; surfaces defined here without a telemetry counterpart remain unimplemented.

---

## Foundational boundary: Operational records vs workspace materialization

**All 7 surfaces below describe recorded operational history** — mutations, runs, failures, allocations, continuations, budgets, diffs. They are evidence of what happened.

**None of them describe current workspace materialization** — what files actually exist on disk right now.

### Why this matters

Coverage, replay, and operation-history describe past operations. They are NOT proof that the current workspace still contains those files. The two layers can drift apart:

| Layer | Source | What it describes | Semantics |
|-------|--------|-------------------|-----------|
| **Operational history** | `runs.json`, `operation-history.json` | Model actions that were *requested* and *recorded* | "The system did X in run R" |
| **Workspace materialization** | Filesystem at `WORKSPACE_ROOT` | Files that currently *exist* on disk | "The workspace currently contains X" |

### The system correctly exposed this drift

In Session 10, coverage showed `ops-demo/src/utils/string.js` as "covered" (written by T7 R7). But the workspace at `WORKSPACE_ROOT=/tmp/op-workspace` did not have that file because the earlier runs wrote to a different server instance. The system exposed this honestly through:

1. **ENOENT** — the readFile operation failed because the file didn't exist
2. **Replay** — showed the exact operation that failed and its step context
3. **Failure Context** — classified as workspace_error with the ENOENT message
4. **Coverage mismatch** — coverage said "covered" but the workspace didn't have it

This honesty is a feature, not a bug. The system correctly refuses to pretend the workspace is in a state it hasn't verified.

### Design constraint

All state surfaces must be honest about what layer they describe:

- **Coverage** describes "was this path ever written?" — it is about operational history, not workspace materialization
- **Replay** describes "what did the model do in this run?" — it is about recorded operations
- **Failure Context** can reference workspace errors, but describes the *run's perspective*, not a verified workspace state

A future surface for **workspace provisioning state** (whether the workspace matches what operational history suggests it should contain) would be a *separate* surface, not mixed into coverage or replay. It would require explicit verification (stat the paths), not inference from history.

**Do not conflate the two layers.** A file being in operation-history does not mean it is on disk. Any surface that implies workspace materialization must explicitly verify it.

---

## Surface 1: Ticket Progression State

**What operators repeatedly need to know:**
"Which numbered items within a ticket are completed vs pending? What is the overall progression?"

**Why this is needed:**
Continuation and recovery workflows require knowing exactly what was already done. After a crash (F4) or partial write (F2/F7), the operator must replay each run and manually compare against the original ticket to determine what remains.

**Current reconstruction method:**
1. Read original ticket objective
2. Replay each run for that ticket
3. Cross-reference replay step output against ticket numbered items
4. Inspect workspace to verify what files exist
5. Make a manual judgment about what items are fully/partially done

**Proposed explicit representation:**
```
/ticket/{id}/progression
{
  "ticketId": 8,
  "totalItems": 4,
  "completedItems": 2,
  "partialItems": 1,
  "pendingItems": 1,
  "items": [
    { "number": 1, "status": "completed", "completedInRun": 3, "mutations": ["folder:create"] },
    { "number": 2, "status": "partial",   "completedInRun": 4, "mutations": ["file:write"], "note": "parent dir missing, write failed" },
    { "number": 3, "status": "completed", "completedInRun": 7, "mutations": ["folder:create", "file:write"] },
    { "number": 4, "status": "pending",   "note": "not attempted" }
  ]
}
```

**Query examples:**
- `oquery progression --ticket 8` → shows completed/partial/pending items
- `oquery progression --ticket 8 --unresolved` → shows only partial + pending items
- `oquery progression --ticket 8 --json` → raw item-level status

**Why this is operational (not cognitive):**
Every field derives from persisted mutation history and replay snapshots. No model inference about intent. No autonomous judgment about "what the operator meant." Each item maps directly to a numbered item in the ticket objective and the mutations that touched its scope.

---

## Surface 2: Mutation Checkpoint State

**What operators repeatedly need to know:**
"What was the last successful mutation before the failure? What mutations happened since checkpoint X?"

**Why this is needed:**
After a crash (F4), malformed action crash (F3), or budget exhaustion (F1), the operator needs to know what durable mutations survived vs what was lost. Currently requires replaying the last run and inspecting operation-history.json.

**Current reconstruction method:**
1. Find the last run for the ticket
2. Replay it step by step
3. Identify which mutations returned `"status": "created"` vs which failed
4. Manually note the last successful mutation before the failure point
5. Inspect workspace to verify durable state

**Proposed explicit representation:**
```
/ticket/{id}/mutations
{
  "ticketId": 8,
  "totalMutations": 14,
  "lastRunId": 4,
  "lastSuccessfulMutation": { "at": "2026-05-19T20:51:06.000Z", "runId": 4, "operation": "writeFile", "path": "ops-demo/src/index.js", "step": 1 },
  "failedMutation": { "at": "...", "operation": "writeFile", "path": "ops-demo/src/utils/math.js", "failure": "ENOENT: parent dir does not exist" },
  "checkpoints": [
    { "checkpointId": 1, "runId": 1, "mutations": 7, "timestamp": "..." },
    { "checkpointId": 2, "runId": 4, "mutations": 1, "timestamp": "..." }
  ]
}
```

**Query examples:**
- `oquery mutations --ticket 8 --since run:1` → mutations that occurred after run 1
- `oquery mutations --ticket 8 --last-successful` → last mutation in the chain that succeeded
- `oquery checkpoints --ticket 8` → per-run mutation counts as timeline

**Why this is operational (not cognitive):**
Each entry maps to a persisted `operation-history.json` record with deterministic status (created, already_exists, error). No interpretation. No state inference. The "last successful" is simply the last mutation with `result.status === "created"`.

---

## Surface 3: Allocation Visibility State

**What operators repeatedly need to know:**
"Which agents were assigned? What did each produce? What is the per-agent status?"

**Why this is needed:**
After allocation (Session 4), there is no single view showing the allocation plan, per-agent runs, and per-agent output paths. The operator must cross-reference `allocation-plans.json`, `runs.json`, and inspect the workspace.

**Current reconstruction method:**
1. Read `allocation-plans.json` to find the plan for the ticket
2. For each allocation item, note the assigned agent and owned output path
3. Filter runs by ticket ID to see which agents actually executed
4. Cross-reference agent names via `agents.json`
5. Inspect workspace at each owned output path

**Proposed explicit representation:**
```
/ticket/{id}/allocation
{
  "ticketId": 9,
  "planId": 2,
  "mode": "owned_paths",
  "agents": [
    {
      "agentId": 1,
      "agentName": "OpAgent-1",
      "subtask": "Produce your allocated output...",
      "ownedPath": "allocated/ticket-9/agent-1/",
      "runId": 9,
      "runStatus": "completed",
      "mutations": 7,
      "outcome": "all_intended"
    },
    {
      "agentId": 2,
      "agentName": "OpAgent-2",
      "subtask": "Produce your allocated output...",
      "ownedPath": "allocated/ticket-9/agent-2/",
      "runId": 10,
      "runStatus": "completed",
      "mutations": 7,
      "outcome": "all_intended"
    }
  ]
}
```

**Query examples:**
- `oquery allocation --ticket 9` → per-agent breakdown
- `oquery allocation --agent 2` → all tickets allocated to agent 2 with status
- `oquery allocation --ticket 9 --unresolved` → agents whose runs failed or are pending

**Why this is operational (not cognitive):**
All fields derive from persisted allocation plans, run records, and agent definitions. No model inference about "who should do what." The allocation plan structure is deterministic — items are created 1:1 with agents in the group.

---

## Surface 4: Continuation Chain State

**What operators repeatedly need to know:**
"Which continuation paths are pending? What is the continuation lineage? Which runs are part of the same continuation chain?"

**Why this is needed:**
Continuation workflows create a chain of runs for the same ticket. Currently, the `continuationOf` field in `replaySnapshot` tracks the parent run, but there's no forward-chain view ("this run was continued by run X") and no per-ticket continuation tree.

**Current reconstruction method:**
1. Find all runs for a ticket
2. Check each run's `replaySnapshot.continuationOf` field
3. Manually build the chain by matching `continuationOf` back to run IDs
4. For forward chains, scan all runs to find child runs
5. No explicit "pending continuation" marker — operator must infer from ticket status

**Proposed explicit representation:**
```
/ticket/{id}/continuations
{
  "ticketId": 8,
  "chain": [
    { "runId": 3, "status": "failed",  "mutations": 0,  "continuationOf": null },
    { "runId": 4, "status": "failed",  "mutations": 1,  "continuationOf": null, "note": "partial write durable" },
    { "runId": 6, "status": "failed",  "mutations": 2,  "continuationOf": null, "note": "partial write durable" },
    { "runId": 7, "status": "completed", "mutations": 5, "continuationOf": null, "note": "fixup ticket for remaining items" }
  ],
  "pendingContinuations": false,
  "totalMutationsAcrossChain": 8,
  "itemsCompleted": "items 1-2 of 4, items 3-5 in fixup"
}
```

**Query examples:**
- `oquery continuations --ticket 8` → full chain with per-run status
- `oquery continuations --pending` → all tickets with open continuation chains
- `oquery continuations --ticket 8 --json` → raw chain data for scripting

**Why this is operational (not cognitive):**
The chain is built from deterministic `continuationOf` fields in replay snapshots and run statuses. "Pending" means last run in chain has status != completed. No model inference about whether more continuation is needed.

---

## Surface 5: Budget Consumption State

**What operators repeatedly need to know:**
"What budget was consumed across all runs for this ticket? What remains available?"

**Why this is needed:**
When planning continuations or assessing why a ticket failed, the operator needs to know cumulative budget usage. Currently, each run's replay shows per-run budget limits, but multiple runs for the same ticket consume budget cumulatively.

**Current reconstruction method:**
1. Find all runs for the ticket
2. For each run, read the replay snapshot's `runtimeLimits` (max values)
3. For each run, count `parsedModelPlans.length` (steps used) and `workspaceOperations.length` (ops used)
4. Sum across runs and compare against per-run budget
5. Manual calculation — no aggregation

**Proposed explicit representation:**
```
/ticket/{id}/budget
{
  "ticketId": 8,
  "perRunBudget": { "steps": 4, "ops": 32, "requests": 4 },
  "usage": {
    "runsConsumed": 4,
    "totalStepsUsed": 8,
    "totalOpsUsed": 21,
    "totalRequestsUsed": 8,
    "averageMutationsPerRun": 2
  },
  "runs": [
    { "runId": 3, "steps": 4, "ops": 5,  "mutations": 0,  "status": "failed" },
    { "runId": 4, "steps": 2, "ops": 2,  "mutations": 1,  "status": "failed" },
    { "runId": 6, "steps": 1, "ops": 5,  "mutations": 2,  "status": "failed" },
    { "runId": 7, "steps": 3, "ops": 9,  "mutations": 5,  "status": "completed" }
  ]
}
```

**Query examples:**
- `oquery budget --ticket 8` → cumulative budget usage
- `oquery budget --ticket 8 --verbose` → per-run breakdown
- `oquery budget --all` → budget usage across all tickets

**Why this is operational (not cognitive):**
Every metric comes from persisted run snapshots. Step count = `parsedModelPlans.length`. Ops count = `workspaceOperations.length`. Mutations = count of mutating operations with `result.status === "created"`. Pure arithmetic aggregation.

---

## Surface 6: Operation Diff State

**What operators repeatedly need to know:**
"What changed between run N and run N+1? Which mutations are new? Which paths were touched?"

**Why this is needed:**
During recovery flows (Session 2), the operator needs to know what a new run contributed compared to previous runs. Currently requires replaying both runs and manually comparing operation lists.

**Current reconstruction method:**
1. Replay run N, note all mutations (paths + operations)
2. Replay run N+1, note all mutations
3. Compare the two sets manually
4. Determine which paths are new vs repeated vs skipped

**Proposed explicit representation:**
```
/runs/{id}/diff?against={previousRunId}
{
  "runId": 6,
  "againstRunId": 4,
  "newMutations": [
    { "operation": "writeFile", "path": "ops-demo/tests/test.js", "status": "created" },
    { "operation": "writeFile", "path": "ops-demo/docs/README.md", "status": "created" }
  ],
  "retriedMutations": [],
  "failedMutations": [
    { "operation": "writeFile", "path": "ops-demo/src/utils/math.js", "failure": "ENOENT" }
  ],
  "summary": { "new": 2, "retried": 0, "failed": 1, "filesTouched": 3, "pathsTouched": 3 }
}
```

**Query examples:**
- `oquery diff --run 6 --against 4` → mutations new in run 6 vs run 4
- `oquery diff --ticket 8 --from-run 3 --to-run 7` → cumulative changes across runs 3-7
- `oquery diff --last-failed --last-successful` → what a failed run attempted vs what its predecessor achieved

**Why this is operational (not cognitive):**
The diff is a set operation on persisted mutation records. "New" means the mutation path+operation does not appear in the comparison run. "Retried" means it appears in both. "Failed" means mutation request exists but result is error. No semantic understanding of file content.

---

## Surface 7: Failure Context State

**What operators repeatedly need to know:**
"What exactly caused the failure? What was the error context? What was the model's last valid output before the error?"

**Why this is needed:**
Currently, some failures provide opaque errors (F3: "Workspace action must be an object"). The error message doesn't show which action was invalid, what the model returned, or what format was expected. The operator must dig into logs to find the model response.

**Current reconstruction method:**
1. Replay the run — shows the error message at the top
2. View logs for the run — find `model:response` entry around the failure time
3. Manually inspect the model's JSON response
4. Identify which action in the array was malformed
5. Cross-reference with expected action format from the primitive contract

**Proposed explicit representation:**
```
/runs/{id}/lastError
{
  "runId": 4,
  "errorType": "invalid_action",
  "errorMessage": "Action at index 1 is not a valid action object: missing required field 'operation'",
  "invalidAction": { "write": "some content", "path": "..." },
  "expectedShape": { "operation": "writeFile", "args": { "path": "...", "content": "..." } },
  "modelResponse": {
    "message": "Read ops-demo/src/index.js...",
    "actions": [
      { "operation": "writeFile", "args": { "path": "ops-demo/src/index.js", "content": "..." } },
      { "write": "some content", "path": "..." }
    ],
    "complete": false
  },
  "timestamp": "2026-05-19T20:51:06.000Z",
  "step": 1,
  "recoverable": true,
  "recoveryHint": "Action 1 missing 'operation' field. Expected operation: writeFile, readFile, createFolder, listDirectory, deletePath, renamePath."
}
```

**Query examples:**
- `oquery failures --ticket 8` → all failure contexts for the ticket
- `oquery failures --type invalid_action` → all malformed action errors
- `oquery failures --recoverable` → errors the model could self-correct with better feedback

**Why this is operational (not cognitive):**
All fields derive from the persisted model response, the primitive contract's allowed operations, and the runtime validation error. No inference about model intent. The "recoverable" flag is deterministic: true if the model could fix the action shape in a subsequent step with corrective feedback.

---

## Summary: From reconstruction to explicit state

| Surface | Layer | Repeated operator question | Current method | Proposed representation |
|---------|-------|--------------------------|----------------|------------------------|
| 1. Progression | operational history | "Which items are done vs pending?" | Manual replay cross-reference | Per-item status derived from mutation history |
| 2. Checkpoint | operational history | "What was the last successful mutation?" | Replay last run + inspect history | Last-successful pointer + per-run mutation sets |
| 3. Allocation | operational history | "Which agents ran and what did each produce?" | Cross-reference 3 JSON files | Per-agent breakdown with run status + owned path |
| 4. Continuation | operational history | "What continuation paths are pending?" | Manual chain-building from continuationOf fields | Continuation tree with pending/complete markers |
| 5. Budget | operational history | "What budget was consumed across all runs?" | Manual per-run arithmetic aggregation | Cumulative step/ops/run totals |
| 6. Diff | operational history | "What changed between runs X and Y?" | Manual replay comparison | Set-diff of mutation paths between runs |
| 7. Failure | operational history | "What exactly caused the error?" | Log inspection for model response | Exact invalid action shape + expected format |

## Invariant check

Every surface above:
- **Derives from persisted data** — runs, operations, allocations, replay snapshots. No model-generated state.
- **Is deterministic** — given the same input data, produces identical output. No heuristics, no inference.
- **Is queryable** — surfaces can be rendered as CLI output or JSON. No hidden state.
- **Has single source of truth** — the operation history and run snapshots. No derived state that diverges from source.
- **Requires no cognitive state** — the model does not need to remember, track, or infer any of these. They are environment-held truths.

## Foundational invariant: Layer honesty

Every surface must be honest about which layer it describes. The two layers with distinct truth values:

| Layer | Described by | Truth value |
|-------|-------------|-------------|
| **Operational history** | coverage, replay, failure context | "A run recorded an operation to path X" |
| **Workspace materialization** | stat, read, ENOENT | "Path X currently exists on disk" |

**No surface should conflate these.** A coverage result ("path was written") is not a workspace guarantee ("path exists now"). The system must expose drift honestly — through ENOENT, missing files in stat results, and mismatch indicators — rather than silently reconciling or pretending alignment.

This boundary is not a bug to fix. It is a design constraint that protects operational truthfulness.
