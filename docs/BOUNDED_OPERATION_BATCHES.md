# Bounded Operation Batches

## Overview

The substrate enforces a bounded operation batch contract. A model response must be exactly one of:

1. **Bounded inspection** — `listDirectory` and/or `readFile` only, within per-profile limits
2. **Bounded operation batch** — an ordered list of `createFolder`, `writeFile`, `renamePath`, `deletePath`
3. **Completion signal** — `complete:true` with or without a final batch

The model may not interleave inspection and mutation in the same response. It may not emit repeated inspection responses. It must fail explicitly if bounded inspection cannot produce a valid batch.

## Principles

### 1. Bounded Inspection

- Inspection limits remain enforced per workload profile.
- No repeated exploratory loops.
- If bounded inspection cannot produce a valid batch, the model must fail explicitly.

### 2. Exactly One Bounded Operation Batch

A batch is an ordered list of existing primitives:
- `createFolder`
- `renamePath`
- `writeFile`
- `deletePath`

No new operation semantics. No recursive expansion. No self-spawning tickets.

### 3. Deterministic Runtime Execution

The runtime validates every primitive independently:
- Authority checks
- Path validation
- Commit fingerprinting (skip duplicates)
- Conflict detection (reject same-path different-op)

### 4. Deterministic Runtime Verification

After executing a primitive, the runtime performs structural verification itself:
- After `renamePath`: source no longer exists, destination exists
- After `createFolder`: folder exists
- After `writeFile`: file exists and content hash matches
- After `deletePath`: path no longer exists

Verification failures are recorded as `batch.verification_failed` events. The runtime does **not** re-enter the model for simple structural verification.

### 5. Model Re-Entry Boundary

The model is called again only for:
- Semantic ambiguity
- Failed verification that requires judgment
- Explicit runtime uncertainty

Normal deterministic verification happens without model re-entry.

### 6. Failure Semantics

If the model cannot produce a valid bounded batch after bounded inspection:
- Fail explicitly
- Do not continue exploratory behavior
- Do not enter `listDirectory` loops

## Example: A/B Organization Task

**Objective:** Create folders A and B, then move all folders starting with A into A and all folders starting with B into B.

**Valid model responses:**

**Step 1 (DISCOVER):**
```json
{
  "message": "Listing workspace root to identify folders",
  "actions": [{"operation":"listDirectory","args":{"path":""}}],
  "complete": false
}
```

**Step 2 (MUTATE — bounded batch):**
```json
{
  "message": "Creating folders and moving matching folders",
  "actions": [
    {"operation":"createFolder","args":{"path":"A"}},
    {"operation":"createFolder","args":{"path":"B"}},
    {"operation":"renamePath","args":{"path":"Alpha","nextPath":"A/Alpha"}},
    {"operation":"renamePath","args":{"path":"Beta","nextPath":"B/Beta"}}
  ],
  "complete": false
}
```

**Step 3 (VERIFY):**
```json
{
  "message": "Verifying folders moved correctly",
  "actions": [
    {"operation":"listDirectory","args":{"path":"A"}},
    {"operation":"listDirectory","args":{"path":"B"}}
  ],
  "complete": true
}
```

**Runtime behavior:**
- Step 1: executes `listDirectory`, records paths
- Step 2: executes each primitive, verifies each independently
  - `createFolder A` → verify folder exists
  - `createFolder B` → verify folder exists
  - `renamePath Alpha → A/Alpha` → verify Alpha no longer exists at root, A/Alpha exists
  - `renamePath Beta → B/Beta` → verify Beta no longer exists at root, B/Beta exists
- Step 3: executes `listDirectory` for confirmation, signals completion

**Invalid model responses (would fail):**

```json
// Repeated inspection without batch
{
  "actions": [{"operation":"listDirectory","args":{"path":""}}],
  "complete": false
}
// Fails: no_progress — bounded inspection already done in step 1
```

```json
// Mixed inspection + mutation in one response
{
  "actions": [
    {"operation":"listDirectory","args":{"path":""}},
    {"operation":"createFolder","args":{"path":"A"}}
  ],
  "complete": false
}
// Fails: mixed_phase — single response must be exactly one phase
```

## Runtime Enforcement

### Phase Compliance
The phase system rejects any response containing both inspection and mutation operations. A response must belong to exactly one execution phase.

### Non-Progress Detection
After a response containing only `listDirectory`/`readFile`, the next response must contain mutations or signal completion. A second inspection-only response is treated as non-progress and fails with:

```
Model repeated inspection-only non-progress twice.
Bounded inspection must be followed by exactly one bounded operation batch.
```

### Batch Verification
After each mutating primitive, the runtime checks structural properties and emits `batch.verification_failed` events if checks fail. No model re-entry occurs for these checks.

### Duplicate/Conflict Prevention
- Same `(operation, args)` fingerprint → skipped as idempotent no-op
- Same path, different operation → rejected as `MUTATION_CONFLICT`

### Operation Count Limits
- `MAX_AGENT_ACTIONS_PER_RESPONSE` (default 8) bounds total actions per response
- `MAX_MUTATING_ACTIONS_PER_RESPONSE` (default 2) bounds mutating actions per response

## Invariants

1. A single model response belongs to exactly one execution phase.
2. Inspection-only responses cannot repeat without progress.
3. Mutating primitives are verified structurally by the runtime without model re-entry.
4. Duplicate primitives are idempotent; conflicting primitives are rejected.
5. Batch operation counts are bounded per response.
6. If bounded inspection cannot yield a valid batch, the run fails explicitly.
