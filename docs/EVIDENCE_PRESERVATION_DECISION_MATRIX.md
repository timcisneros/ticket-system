# Evidence Preservation Decision Matrix

## Method

Re-examined each candidate at the exact line of replacement to determine:
1. Whether `actionResults` contains evidence at the point of replacement
2. Whether the `actions` variable (proposed but not executed) exists in scope
3. What the runtime flow is (pre-execution rejection vs. post-execution enforcement)

---

## Critical Finding

For **all three candidates**, `actionResults` is **empty** at the point of replacement because these checks occur **before** the execution loop. The `actionResults = []` reset happens on line 8654, and the checks fire before any workspace operations execute.

The Option B pattern (`push` instead of `=`) would have **zero effect** on these three because there is nothing to preserve in `actionResults`.

The only meaningful change would be to **include the proposed (but rejected) actions in the warning payload** — which is a different operation from evidence preservation.

---

## Candidate 1: Action Limit (line 8671)

### Does evidence actually exist at the point of replacement?

**In `actionResults`: No.** The array was reset to `[]` on line 8654. No workspace operations have executed.

**In scope: Yes.** The `actions` variable contains all proposed actions. The `message` variable includes the count (`${actions.length}`). The event payload (line 8666) records `actionCount` but not the individual actions.

### Would preserving that evidence improve model adaptation?

**Mechanical `push` fix: No effect** — `actionResults` is empty.

**Including proposed actions in warning: Potentially yes.** The model would see *which* actions it proposed, not just *how many*. This could help it select the first `MAX_AGENT_ACTIONS_PER_RESPONSE` actions in the next turn.

### Could preserving that evidence weaken enforcement?

No. Enforcement is a hard pre-execution rejection. Including the rejected actions in the feedback does not change the rejection boundary.

### Could preserving that evidence create contradictory feedback?

Low risk. The feedback would be: "You proposed these 10 actions. Only 8 are allowed. Here is the full list; retry with at most 8." This is factual and non-contradictory.

### Is there replay evidence supporting the change?

No. We have no replay runs where the model hit the action limit, then received its proposed actions back, and adapted successfully.

### Recommended

**Leave alone.**

The mechanical `push` fix has no effect here because `actionResults` is empty. Augmenting the warning with the proposed actions is a new feature, not evidence preservation. The current warning already tells the model the exact count and the limit. That is sufficient for a compliant model to adapt.

---

## Candidate 2: Mutating Action Limit (line 8734)

### Does evidence actually exist at the point of replacement?

**In `actionResults`: No.** Same as above — pre-execution check, array is empty.

**In scope: Yes.** The `actions` variable exists. The event stream already captures `droppedActions` (lines 8711–8713) with full operation/path detail. The `mutatingActionLimitSignature` is computed from the actions. But `actionResults` contains none of this.

### Would preserving that evidence improve model adaptation?

**Mechanical `push` fix: No effect** — `actionResults` is empty.

**Including proposed actions in warning: Potentially yes.** The model would see which specific mutating actions it proposed. This could help it select the first `MAX_MUTATING_ACTIONS_PER_RESPONSE` mutating actions in the next turn.

### Could preserving that evidence weaken enforcement?

No. Enforcement remains a hard rejection before execution.

### Could preserving that evidence create contradictory feedback?

Low risk. The feedback would be: "You proposed these 3 mutating actions. The limit is 2. Here they are; retry with at most 2."

### Is there replay evidence supporting the change?

No. No experiments on this specific failure mode with augmented feedback.

### Recommended

**Leave alone.**

Same reasoning as action limit. The `push` fix is mechanically inert here. The current warning already specifies the exact mutating count, the limit, and the allowed operation types. The event stream preserves the full `droppedActions` for operator debugging. The model has enough information to adapt if it is compliant.

---

## Candidate 3: Phase Violation (line 8764)

### Does evidence actually exist at the point of replacement?

**In `actionResults`: No.** Pre-execution check, array is empty.

**In scope: Yes.** The `actions` variable exists. The event stream already captures the full `actions` array (lines 8757–8761) with operation/path detail.

### Would preserving that evidence improve model adaptation?

**Mechanical `push` fix: No effect** — `actionResults` is empty.

**Including proposed actions in warning: Uncertain.** A phase violation means the model emitted a mixed-phase response (e.g., `listDirectory` + `renamePath` in the same response). The problem is not *which* actions were proposed but *how they were grouped*. Showing the model its own rejected actions might help it understand the phase grouping rule, but it might also confuse it ("These actions look fine to me individually").

### Could preserving that evidence weaken enforcement?

No.

### Could preserving that evidence create contradictory feedback?

**Higher risk than the other two.** If the model sees "You proposed listDirectory and renamePath together. That is a mixed-phase response," it might not understand *why* they cannot be grouped. The current message says "Actions in this response must all belong to the same allowed phase," which is the rule. Adding the action list could add noise without clarifying the rule.

### Is there replay evidence supporting the change?

No.

### Recommended

**Leave alone.**

Same mechanical issue: `push` has no effect. For this candidate, including the action list in the warning carries higher confusion risk because the learning task is about phase grouping, not about selecting a subset. The current message already states the rule explicitly.

---

## Ranking by Expected Value

| Rank | Candidate | Expected Value | Rationale |
|------|-----------|----------------|-----------|
| 1 | **Mutating action limit** | Low positive | The event stream already preserves `droppedActions`. Aligning the prompt feedback with the event stream would be consistent. The learning task (select first N mutating actions) is concrete. |
| 2 | **Action limit** | Very low positive | Similar to mutating limit, but simpler (just count). The model already receives the exact count. Adding the action list is marginal value. |
| 3 | **Phase violation** | Neutral / slightly negative | The learning task is about phase grouping, not action selection. Adding the action list could confuse weak models. The current rule-based message is clearer. |

---

## Conclusion

None of the three remaining candidates benefit from the Option B mechanical fix (`push` instead of `=`) because `actionResults` is empty at all three locations. These are **pre-execution rejection boundaries**, not **post-execution enforcement boundaries**.

The no-progress case was special because:
- The actions were **already executed** (workspace operations ran, results were generated)
- `actionResults` contained the actual inspection results
- The runtime **destroyed** those results by overwriting the array
- Preserving them allowed `buildTransitionGuidance` to fire using existing evidence

The action limit, mutating action limit, and phase violation cases are different because:
- No actions were executed
- `actionResults` was already empty
- There is no evidence to preserve in the prompt feedback loop
- The event stream already captures the full proposed actions for operator debugging

**Verdict:** The Option B fix was correctly scoped to the no-progress case. The remaining candidates are not evidence-destruction bugs; they are pre-execution rejection boundaries where no evidence existed in the prompt feedback loop to begin with.

---

*All claims derived from direct code inspection of `server.js` lines 8650–8769, tracing the execution flow from `actionResults = []` (8654) through each check to the execution loop start (8820).*
