# Evidence Preservation Principle

## Question

Where else in the substrate do we destroy evidence, replace evidence, or collapse evidence into warnings?

---

## Method

Searched `server.js` for all patterns matching:
- `actionResults = [{` — evidence replacement in the prompt feedback loop
- `appendEvent`, `appendRunLog`, `appendRunReplaySnapshotItem` — append-only surfaces
- `sanitizeSnapshotValue`, `sanitizeLogMessage` — evidence filtering/collapse
- `checkPostconditionCompletion`, `verifyBatchOperation`, `checkObviousTicketPostcondition` — read-only evidence consumers

---

## 1. actionResults

### How actionResults works

`actionResults` is the per-step feedback array passed to `buildAgentPrompt` as `previousActionResults`. It carries what the model did and what happened. Each loop iteration starts with `actionResults = []` (line 8654), then accumulates items as actions execute. After the step, the array is fed into the next prompt.

### Evidence replacement locations

There are **5 locations** where `actionResults` is overwritten with a single warning item, destroying all accumulated operation results from that step:

| Location | Line | Condition | Warning type | Evidence destroyed |
|----------|------|-----------|------------|-------------------|
| Action limit | 8671 | `actions.length > MAX_AGENT_ACTIONS_PER_RESPONSE` | `model:action_limit` | All proposed actions |
| Mutating action limit | 8734 | `mutatingActionCount > MAX_MUTATING_ACTIONS_PER_RESPONSE` | `model:mutating_action_limit` | All proposed actions |
| Phase violation | 8764 | `!phaseCheck.compliant` | `execution.phase_violation` | All proposed actions |
| Stalled | 8809 | `!modelPlan.complete && actions.length === 0` (2nd time) | `model:stalled` | N/A (no actions) |
| No-progress | 9078 | `isInspectionOnly && noProgressResponses >= 1` | `model:no_progress` | All inspection results |

**Fixed:** The no-progress location (line 9078) was changed from `actionResults = [{warning...}]` to `actionResults.push({warning...})` in Option B.

**Remaining:** 4 locations still replace evidence with warnings.

### What evidence is lost

When any of the above conditions trigger, the model never sees:
- Which actions were proposed
- Which actions succeeded or failed
- Workspace operation results (directory entries, file contents)
- Operation durations or history IDs

The model sees only the warning message on the next turn.

---

## 2. Replay Snapshots

### Evidence preserved?

**Yes.** `appendRunReplaySnapshotItem` (line 4274) is purely append-only:

```javascript
[key]: [...items, { ...item, capturedAt: new Date().toISOString() }]
```

No item is ever overwritten or removed.

### What is captured

- `providerRequests` — full request bodies
- `modelResponses` — full response text
- `parsedModelPlans` — parsed actions
- `workspaceOperations` — operation + result
- `events` — runtime events
- `authorityChecks` — enforcement decisions
- `workflowDrafts`, `workflowDraftIntents`, `handoffTasks`

### Evidence lost?

None. The replay snapshot surface is fully append-only and complete.

---

## 3. Event Streams

### Evidence preserved?

**Yes.** `appendEvent` (line 2075) writes to `data/events.jsonl` in append-only fashion:

```javascript
const line = `${JSON.stringify(normalized)}\n`;
pendingEventBuffer.push(normalized);
```

### Evidence lost?

`sanitizeSnapshotValue` is applied to payloads. Sensitive keys are redacted (`[redacted]`). This is evidence filtering, not destruction — the event still exists, but some fields are masked.

---

## 4. Postcondition Checks

### checkPostconditionCompletion (line 4437)

**Read-only.** This function reads `actionResults` to determine if all mutations were redundant. It never modifies the input array.

### checkObviousTicketPostcondition (line 4567)

**Read-only.** Checks workspace state against the ticket objective. No evidence modification.

### Evidence preserved?

**Yes.** Postcondition layers consume evidence; they do not destroy it.

---

## 5. Verification Paths

### verifyBatchOperation (line 7777)

Performs deterministic post-execution checks (e.g., source still exists after rename). Results are pushed to the `checks` array and emitted as events:

```javascript
appendEvent({ type: 'batch.verification_failed', ... });
```

### Evidence preserved?

**Yes.** Verification generates new evidence; it does not destroy existing evidence.

---

## 6. Sanitization Surfaces

### sanitizeSnapshotValue (line 2015)

Applied to:
- Event payloads
- Replay snapshot items
- Operation history records
- Log messages

It redacts sensitive keys and sanitizes strings. This is evidence **filtering**, not destruction. The record still exists; some fields are masked.

### sanitizeLogMessage (line 1921)

Truncates long strings and strips control characters. Evidence is **collapsed** (truncated), not destroyed.

---

## Inventory Summary

| Surface | Pattern | Evidence Impact | Count |
|---------|---------|-----------------|-------|
| actionResults (action limit) | `actionResults = [{warning}]` | Replaces all proposed actions with warning | 1 |
| actionResults (mutating limit) | `actionResults = [{warning}]` | Replaces all proposed actions with warning | 1 |
| actionResults (phase violation) | `actionResults = [{warning}]` | Replaces all proposed actions with warning | 1 |
| actionResults (stalled) | `actionResults = [{warning}]` | Replaces empty actions with warning | 1 |
| actionResults (no-progress) | **Now `push`** | **Preserves evidence** | Fixed |
| Replay snapshots | `appendRunReplaySnapshotItem` | Append-only, no loss | 0 |
| Event streams | `appendEvent` | Append-only, redaction only | 0 |
| Logs | `appendRunLog` | Append-only, truncation only | 0 |
| Operation history | `histories.push(record)` | Append-only, no loss | 0 |
| Postcondition checks | Read-only | No modification | 0 |
| Verification paths | `appendEvent` | Generates new evidence | 0 |

---

## Candidates for Improvement (Without New Runtime Concepts)

### Candidate 1: Mutating action limit (line 8734)

**Current:**
```javascript
actionResults = [{
  warning: 'model:mutating_action_limit',
  message: 'You returned X mutating workspace actions, exceeding the limit...'
}];
```

**Behavioral impact:** The model proposed some valid actions and some over-limit actions. It never learns which ones were valid.

**Fix (Option B pattern):**
```javascript
actionResults.push({
  warning: 'model:mutating_action_limit',
  message: '...'
});
```

This preserves the successfully executed actions (which were already within the limit) alongside the warning.

**Invariant impact:** None. No new concepts.

### Candidate 2: Action limit (line 8671)

**Current:**
```javascript
actionResults = [{
  warning: 'model:action_limit',
  message: 'You returned X workspace actions, exceeding the per-response limit...'
}];
```

**Behavioral impact:** If the model proposed 10 actions and the limit is 8, the runtime rejects the entire batch. The model does not learn which 8 actions were structurally valid.

**Fix:** Append warning to existing results (if any were executed before the limit check) or preserve the proposed action list in the warning payload.

**Invariant impact:** None.

### Candidate 3: Phase violation (line 8764)

**Current:**
```javascript
actionResults = [{
  warning: 'execution.phase_violation',
  message: 'Mixed-phase response...'
}];
```

**Behavioral impact:** The model never sees which specific actions caused the mixed-phase violation.

**Fix:** Append warning to existing results, or include the action list in the warning payload.

**Invariant impact:** None.

### Candidate 4: Stalled (line 8809)

**Current:**
```javascript
actionResults = [{
  warning: 'model:stalled',
  message: 'You returned complete:false with no workspace actions...'
}];
```

**Behavioral impact:** No actions were proposed, so there is no operation evidence to preserve. This is the only case where replacement is harmless — there is nothing to overwrite.

**Verdict:** Not a candidate. No evidence exists to preserve.

---

## Conclusion

The substrate has **one concentrated evidence destruction pattern**: the `actionResults` assignment at enforcement boundaries. Four locations remain after the Option B fix. All other surfaces (replay snapshots, events, logs, operation history, postconditions, verification) are append-only or read-only.

The fix pattern is consistent and minimal: **append the warning to existing evidence instead of replacing it.** This requires no new runtime concepts, no new abstractions, and no new state. It simply stops destroying evidence that is already present.

| Candidate | Location | Evidence Lost | Fix Complexity |
|-----------|----------|-------------|----------------|
| Mutating action limit | 8734 | Valid actions alongside over-limit ones | One-line change to `push` |
| Action limit | 8671 | Structurally valid actions in rejected batch | One-line change to `push` |
| Phase violation | 8764 | Individual actions that caused mixed-phase | One-line change to `push` |
| Stalled | 8809 | N/A — no actions proposed | No change needed |

---

*All claims derived from direct code inspection of `server.js` lines 8650–9087, 2075–2104, 4274–4288, 4437–4481, 4567–4580, 7777–7826.*
