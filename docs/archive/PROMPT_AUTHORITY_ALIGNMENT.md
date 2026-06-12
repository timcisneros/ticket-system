# Prompt Authority Alignment

## Question

Is the prompt statement:

> "Use only the operations listed in runtimeEnvelope.allowedOperations."

architecturally correct given `docs/ALLOWED_OPERATIONS_AUTHORITY.md`?

---

## Evidence: Current Prompt Construction

From `server.js` lines 8368–8369:

```javascript
'Use only the operations listed in runtimeEnvelope.allowedOperations.',
'Your current execution phase is runtimeEnvelope.currentPhase. In this phase, the allowed operations are: ' + phaseGatedOps.join(', ') + '.',
```

And the JSON schema response shape (line 8390) uses:

```javascript
`{"operation":"${allowedOperationList}",...}`
```

where `allowedOperationList = phaseGatedOps.join('|')` (line 8326).

---

## 1. What authority is runtimeEnvelope.allowedOperations intended to express?

Per `docs/ALLOWED_OPERATIONS_AUTHORITY.md`:

> "`runtimeEnvelope.allowedOperations` should remain the full agent-config-filtered catalog. Its architectural role is to declare the primitive operations available to this agent for this run, independent of phase, workload profile, or step."

It expresses **primitive capability** — the toolbox this agent was assigned at run creation, filtered only by agent-level config (e.g., `allowHandoffTask: false`).

---

## 2. What authority is the phase-gated catalog intended to express?

The phase-gated catalog (`phaseGatedOps`) is computed in `buildAgentPrompt` via:

```javascript
const phaseGatedOps = buildPhaseGatedCatalog(currentPhase, baseAllowedOps);
```

It expresses **operational authority** — the subset of the primitive toolbox that is appropriate for the current execution phase (`planning`, `inspection`, `mutation`, `verification`, `terminalization`).

This is an operational context layer applied *on top of* the primitive contract.

---

## 3. Are those currently conflated in the prompt?

**Yes. The prompt presents contradictory authorities.**

### Signal 1 (line 8368): Primitive authority
> "Use only the operations listed in runtimeEnvelope.allowedOperations."

This names the envelope field as the sole authority. The envelope contains the full primitive catalog (8 operations for a typical agent). This signal is **operational** in framing ("Use only...") but **primitive** in reference.

### Signal 2 (line 8369): Phase authority
> "Your current execution phase is runtimeEnvelope.currentPhase. In this phase, the allowed operations are: listDirectory, readFile."

This names the phase-gated subset as the operational authority. In the `inspection` phase, this restricts the model to 2 operations. This signal is **operational** in both framing and reference.

### Signal 3 (line 8390): Schema authority
> `{"operation":"listDirectory|readFile",...}`

The JSON schema enum reinforces Signal 2 (phase authority) by showing only the phase-gated operations in the response template.

### The contradiction

Signal 1 tells the model to trust the full catalog. Signals 2 and 3 tell the model to trust the phase subset. These are incompatible.

In Runs #77 and #79, the model repeated `listDirectory` in the `inspection` phase. This behavior is consistent with the model following Signal 1 (the full catalog still contains `listDirectory`) while ignoring Signal 2. Alternatively, the model may be confused by the contradiction and defaulting to the broader permission.

Either way, the prompt is **not architecturally correct** because it instructs the model to treat the primitive capability manifest as the operational authority.

---

## 4. What is the minimum prompt change required?

### Requirement

The change must:
- Preserve `runtimeEnvelope.allowedOperations` as primitive authority (no envelope changes)
- Make the prompt internally consistent
- Not add new runtime semantics or new envelope fields
- Be minimal in scope

### Analysis of options

| Option | Change | Pros | Cons |
|--------|--------|------|------|
| A | Delete line 8368 entirely | Removes contradiction completely | Model loses any explicit instruction about where to find the allowed operations; may look only at the JSON blob which still shows the full catalog |
| B | Change 8368 to: `"Your agent supports the operations in runtimeEnvelope.allowedOperations. Use only the operations for your current phase, listed below."` | Explicitly distinguishes primitive vs. operational authority; adds no new concepts | Slightly longer |
| C | Change 8368 to: `"Use only the operations appropriate to your current execution phase, as listed below."` | Minimal text change; removes contradiction; phase list already present in 8369 | None significant |
| D | Change 8369 to stop mentioning phase-gated ops, and instead say `"Use only the operations listed in runtimeEnvelope.allowedOperations."` | Aligns with envelope | **Rejects phase gating entirely**; violates the design intent of the phase system |

### Recommended minimum change

**Option C — replace line 8368 with a phase-referenced instruction.**

```javascript
'Use only the operations appropriate to your current execution phase, as listed below.',
```

This is the minimum change because:

1. **One line replacement.** No new fields, no new functions, no new concepts.
2. **Removes the contradiction.** The prompt no longer tells the model to trust the full catalog as operational authority.
3. **Preserves the primitive information.** `runtimeEnvelope.allowedOperations` is still present in the JSON blob as data; the model can still observe it if it needs to know its full primitive capability set.
4. **Leverages existing text.** Line 8369 already provides the phase-gated list. The instruction now points to that existing text.
5. **Matches the architectural definition.** The operational authority is the phase-gated catalog; the primitive authority is the envelope field. The prompt correctly reflects this layering.

### What about the JSON schema?

The schema already uses `allowedOperationList` (phase-gated ops). No change is needed there — it is already aligned.

### What about the envelope blob?

The `runtimeEnvelope` JSON object is still sent as a user message. It still contains `allowedOperations` with the full catalog. This is correct architecturally (primitive manifest) and requires no change.

---

## Summary

| Question | Answer |
|----------|--------|
| Is the current statement architecturally correct? | **No.** It conflates primitive capability with operational authority. |
| What authority does `runtimeEnvelope.allowedOperations` express? | **Primitive capability** — the full agent-config-filtered toolbox. |
| What authority does the phase-gated catalog express? | **Operational authority** — the phase-appropriate subset. |
| Are they conflated? | **Yes.** The prompt instructs the model to use the full catalog as the operational limit, while the prose and schema simultaneously restrict to the phase subset. |
| Minimum prompt change? | **Replace line 8368** with: `"Use only the operations appropriate to your current execution phase, as listed below."` |

---

*All claims derived from direct inspection of `server.js` lines 8322–8410 and evaluation against `docs/ALLOWED_OPERATIONS_AUTHORITY.md`.*
