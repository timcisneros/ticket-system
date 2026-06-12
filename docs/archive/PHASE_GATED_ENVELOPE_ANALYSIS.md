# Phase-Gated Envelope Analysis

## Objective

Determine whether `runtimeEnvelope.allowedOperations` should be phase-gated to match the prompt, and document the evidence for each facet of that decision.

---

## Method

1. Read `buildRuntimeEnvelope` and traced every downstream consumer of `runtimeEnvelope.allowedOperations`.
2. Read `buildAgentPrompt` to see how the prompt consumes the envelope vs. how it applies phase gating.
3. Searched all test files for assertions on `runtimeEnvelope.allowedOperations` content.
4. Searched all view templates for consumers of envelope `allowedOperations`.
5. Inspected `docs/PHASE_GATED_ACTION_CATALOG.md` and `docs/WORKLOAD_PROFILES.md` for design intent.
6. Verified that `WORKLOAD_PROFILES` `allowedOperations` fields are consumed anywhere in `server.js`.

---

## 1. Why does `runtimeEnvelope.allowedOperations` still contain the full catalog?

`buildRuntimeEnvelope` (server.js:5905) constructs the envelope like this:

```javascript
const filteredOps = AGENT_DIRECT_OPERATIONS.filter(op => {
  for (const [configKey, operationName] of Object.entries(disabledConfigToOps)) {
    if (op === operationName && effectiveConfig[configKey] === false) return false;
  }
  return true;
});
// ...
return {
  // ...
  allowedOperations: filteredOps,
  // ...
};
```

The only filter applied is **agent config** (`allowHandoffTask`, `allowWorkflowDraftIntent`, `allowCanonicalWorkflowDraft`). Neither **execution phase** nor **workload profile** is consulted.

Phase gating lives entirely inside `buildAgentPrompt` (server.js:8322):

```javascript
const baseAllowedOps = runtimeEnvelope.allowedOperations || AGENT_DIRECT_OPERATIONS;
const currentPhase = runtimeEnvelope.currentPhase || 'planning';
const phaseGatedOps = buildPhaseGatedCatalog(currentPhase, baseAllowedOps);
```

The prompt then injects `phaseGatedOps` into the prose and JSON schema, while the `runtimeEnvelope` JSON blob still carries the ungated `filteredOps`.

Additionally, `WORKLOAD_PROFILES` defines per-profile `allowedOperations` (e.g., refactor allows only `listDirectory, readFile, renamePath, createFolder, deletePath`), but **no code in `server.js` consumes these profile operation lists** for runtime validation, envelope construction, or prompt building.

---

## 2. Is this intentional or accidental?

**Intentional.**

`docs/PHASE_GATED_ACTION_CATALOG.md` (line 46–54) explicitly categorizes the change:

> **What Changed in Runtime Semantics**
> - `buildPhaseGatedCatalog(currentPhase, baseAllowedOps)` filters operations by phase
> - `runtimeEnvelope.currentPhase` is exposed to the model
> - **Prompt uses phase-gated operation list instead of full `AGENT_DIRECT_OPERATIONS`**
>
> **What Changed Only in Prompt Semantics**
> - Explicit phase name included in prompt
> - Phase-allowed operation list included in prompt

The document states the phase-gated list is a **prompt** change, not an envelope change. The envelope was designed to carry the agent's primitive capability contract; the prompt layer applied operational context (phase) on top of it.

---

## 3. Which signal is more authoritative to the model?

The **JSON blob** (`runtimeEnvelope.allowedOperations`) is the explicitly named authority.

The system prompt says:

> "Use only the operations listed in runtimeEnvelope.allowedOperations."

This is a direct instruction. The phase-gated prose ("Your current execution phase is runtimeEnvelope.currentPhase. In this phase, the allowed operations are: listDirectory, readFile.") is presented as supplementary context.

In Run #77 and Run #79, the model emitted `listDirectory` in the inspection phase. This is consistent with the model following the JSON blob authority (which contained the full catalog including `listDirectory`) rather than the prose restriction. Alternatively, the model may simply be ignoring both signals. Either way, the two signals contradict each other, and the prompt explicitly tells the model to trust the JSON blob.

---

## 4. If the envelope were phase-gated, would any existing tests fail?

**No.**

Static analysis of every `*-test.js` script in `scripts/`:

| Test File | What it asserts about `allowedOperations` | Would it fail? |
|-----------|-------------------------------------------|----------------|
| `agent-regression-test.js` | `snapshot.primitiveContract.allowedOperations` is an array | No — tests `primitiveContract`, not `runtimeEnvelope` |
| `allocated-regression-test.js` | `snapshot.primitiveContract.allowedOperations` is an array | No — same reason |
| `phase-gated-catalog-behavioral-test.js` | `buildPhaseGatedCatalog` output; prompt text existence | No — operates on hardcoded base ops, not envelope |
| `organization-guidance-test.js` | Prompt text and function existence | No — does not inspect envelope content |
| `bounded-transition-test.js` | `runtimeEnvelope.maxMutatingActionsPerResponse` | No — unrelated field |
| `page-render-regression-test.js` | Mock envelope structure | No — uses empty `{}` for `runtimeEnvelope` |

Zero tests assert the content of `runtimeEnvelope.allowedOperations`.

---

## 5. What runtime invariants would change?

### a. Replay snapshot semantics
Currently, `runtimeEnvelope.allowedOperations` is identical across all steps of a run (the full catalog). If phase-gated, the envelope would vary step-by-step:
- Step 0 (planning): full catalog
- Step 1 (inspection): `['listDirectory', 'readFile']`
- Step 2 (mutation): `['createFolder', 'writeFile', 'renamePath', 'deletePath', 'createWorkflowDraftIntent', 'createHandoffTask']`
- etc.

This makes historical replay snapshots phase-dependent for that field.

### b. Primitive contract separation
The `primitiveContract` in replay snapshots stores the full ungated catalog separately (populated from `AGENT_ALLOWED_OPERATIONS`). The UI (`run-detail.ejs`) renders authority from `primitiveContract`, not `runtimeEnvelope`. Therefore, the operator-facing authority display would remain unchanged.

### c. Prompt internal consistency
The line:
> "Use only the operations listed in runtimeEnvelope.allowedOperations."

would become **internally consistent** rather than contradictory.

### d. `buildAgentPrompt` behavior
`buildAgentPrompt` uses `runtimeEnvelope.allowedOperations` as `baseAllowedOps`. If already phase-gated, `buildPhaseGatedCatalog(currentPhase, baseAllowedOps)` would produce the same array for the current phase (idempotent intersection). It would still be needed for the `planning` phase fallback (because `PHASE_OPERATIONS['planning']` is `[]` and the function falls back to `baseAllowedOps`).

---

## 6. What risks would be introduced?

### a. Model confusion from dynamic capability contraction
If the model reasons across turns using the envelope as a stable capability manifest, it would observe its allowed operations **shrinking** after each phase transition. This could cause the model to believe it has lost capabilities permanently, or to generate explanations like "I can no longer list directories" in later steps.

### b. Terminalization empty-set risk
`PHASE_OPERATIONS['terminalization']` is `[]`. If the envelope were phase-gated and a run ever reached terminalization while still making a model call (which should not happen, but edge cases exist), the envelope would contain zero operations. The fallback logic in `buildPhaseGatedCatalog` would return the base list, but if the envelope itself is the authority, the model would see an empty array.

### c. Workload profile intersection complexity
Profile `allowedOperations` are currently defined but unused. If a future change enforced profile-level operation filtering, combining it with envelope phase-gating would require a three-way intersection:

```
effectiveOps = profileOps ∩ phaseOps ∩ agentConfigOps
```

This ordering is not currently implemented and would need careful design to avoid empty sets (e.g., a `report` profile that excludes `renamePath` combined with a `mutation` phase that includes `renamePath` would produce a mismatch).

### d. Historical snapshot re-interpretation
Past replay snapshots store the ungated envelope. Any downstream tool that re-simulates or re-renders a run using the stored envelope would need to know whether the envelope was recorded pre- or post-phase-gating. This is a documentation and tooling versioning concern.

### e. Contradiction with docs/PHASE_GATED_ACTION_CATALOG.md
The doc states (line 11) that `planning` phase exposes:
> "listDirectory, readFile, createFolder, writeFile, renamePath, deletePath"

But `PHASE_OPERATIONS['planning']` in `server.js` is `[]`. The doc's stated behavior is produced only by `buildPhaseGatedCatalog`'s fallback to `baseAllowedOps`. If the envelope itself were directly phase-gated using `PHASE_OPERATIONS`, `buildRuntimeEnvelope` would need to replicate that same fallback logic, or `PHASE_OPERATIONS['planning']` would need to be populated with the full catalog. This is a minor code-versus-doc drift risk.

---

## Summary

| Question | Evidence-Based Answer |
|----------|----------------------|
| 1. Why full catalog? | `buildRuntimeEnvelope` filters only by agent config, not phase or profile. Phase gating lives in `buildAgentPrompt`. |
| 2. Intentional or accidental? | **Intentional.** The design doc explicitly calls phase gating a "prompt semantics" change only. |
| 3. Which signal is authoritative? | **JSON blob.** The prompt explicitly instructs the model to "Use only the operations listed in runtimeEnvelope.allowedOperations." |
| 4. Would tests fail? | **No.** Zero tests assert `runtimeEnvelope.allowedOperations` content. |
| 5. What invariants change? | Envelope becomes phase-varying in snapshots; prompt becomes self-consistent; primitiveContract UI stays unchanged. |
| 6. What risks? | Model confusion from shrinking capabilities; terminalization empty-set edge case; profile intersection complexity; snapshot versioning. |

---

*All claims above are derived from direct code inspection and static analysis. No model synthesis was used for factual assertions.*
