# Execution Phases

## Overview

The runtime enforces a phase-aware execution contract: **a single model response must belong to exactly one execution phase**. This prevents agents from mixing planning, inspection, mutation, and verification into one uncontrolled loop.

Phase state tracks the run's operational stage and forward progression for observability, but does not constrain which single-phase response the model may emit. The only rejection boundary is mixed-phase responses.

## Phases

### 1. Planning
**Allowed operations**: None (message-only)
**Purpose**: The agent thinks, plans, or explains its approach without touching the workspace.
**Rules**:
- A response with `complete: false` and no actions is a planning step.
- No workspace operations are permitted in planning phase.

### 2. Inspection
**Allowed operations**: `listDirectory`, `readFile`
**Purpose**: The agent gathers evidence about the workspace before making changes.
**Rules**:
- Only read/list operations are permitted.
- All actions in the response must be inspection operations.

### 3. Mutation
**Allowed operations**: `writeFile`, `createFolder`, `renamePath`, `deletePath`, `createWorkflowDraft`, `createWorkflowDraftIntent`, `createHandoffTask`
**Purpose**: The agent makes changes to the workspace.
**Rules**:
- Only mutating operations are permitted.
- All actions in the response must be mutation operations.

### 4. Verification
**Allowed operations**: `listDirectory`, `readFile`
**Purpose**: The agent confirms that mutations produced the expected result.
**Rules**:
- Only read/list operations are permitted.
- All actions in the response must be inspection operations.

### 5. Terminalization
**Allowed operations**: None
**Purpose**: The run is completing. No further model or workspace operations are permitted.
**Rules**:
- Terminalization is entered when `completeAgentRun`, `failAgentRun`, or `interruptAgentRun` is called.
- No further model calls or workspace operations are allowed.

## Phase Transition Rules

The phase state tracks forward progression:

```
planning → inspection → mutation → verification → terminalization
```

- Phase state advances forward when a response infers a later phase.
- Phase state does not move backward (backward responses are allowed, but state stays at the higher phase).
- Staying in the same phase is always allowed.
- Terminalization is irreversible.

## Enforcement

### Per-Response Phase Inference
After the model returns a response, the runtime infers the phase from the actions:
- No actions → `planning`
- All actions are `listDirectory`/`readFile` → `inspection` (or `verification` if current phase is `mutation`/`verification`)
- All actions are mutating → `mutation`
- Mixed action types → `mixed` (violation)

### Phase Compliance Check
The runtime checks each response:
1. If `mixed`, emit `execution.phase_violation` event with type `mixed_phase` and reject the response.
2. If `terminalization` with actions, emit `execution.phase_violation` event with type `terminalization_blocked` and reject the response.
3. If compliant and phase moved forward, emit `execution.phase_transition` event and update `run.currentPhase`.

### Resume Compatibility
When resuming a run, `reconstructResumableState` replays phase transition events from the event log to restore `run.currentPhase`. This ensures phase tracking continues correctly after a process restart.

## Event Types

### `execution.phase_transition`
Emitted when the run advances to a new phase.
```json
{
  "type": "execution.phase_transition",
  "ticketId": 1,
  "runId": 1,
  "stepId": "3",
  "payload": {
    "fromPhase": "inspection",
    "toPhase": "mutation",
    "reason": "Inferred from model response actions"
  }
}
```

### `execution.phase_violation`
Emitted when a response violates phase rules.
```json
{
  "type": "execution.phase_violation",
  "ticketId": 1,
  "runId": 1,
  "stepId": "3",
  "payload": {
    "currentPhase": "mutation",
    "inferredPhase": "mixed",
    "violationType": "mixed_phase",
    "reason": "Mixed-phase response: actions belong to different execution phases",
    "actions": [{"operation": "writeFile", "path": "a.txt"}, {"operation": "readFile", "path": "b.txt"}]
  }
}
```

## Run State

The `run` object stores the current phase:
```json
{
  "id": 1,
  "currentPhase": "mutation",
  ...
}
```

- `currentPhase` is initialized to `planning` when the run is created.
- `currentPhase` is normalized to `planning` if it contains an unknown value when loading runs.
- `currentPhase` is set to `terminalization` when the run completes, fails, or is interrupted.

## Invariants

1. **A single model response must belong to exactly one execution phase.**
2. Phase state tracks forward progression (does not move backward).
3. `terminalization` is terminal — no further model or workspace operations.
4. Phase state is reconstructible from events (replayable).
5. Phase violations are recorded as evidence, not silently dropped.
