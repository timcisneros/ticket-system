# Replay Experiment: maxMutatingActionsPerResponse 2→3

## Setup

- **Server**: `AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE=3` (confirmed: all suppression events show `limit=3`)
- **Model**: gpt-4.1-mini (Agent 1, same as original runs)
- **Objective**: "put items 1-5 in a folder called A" (same as original runs 165-171)
- **Workspace**: `.local-workspace` with `items/item-01.txt` through `item-05.txt` (same layout)
- **All other controls untouched**: no-progress detection, step budget (4), model, prompts, workspace

## Results

| Run | Mutations Proposed | Sup-pressed? | Mutations Executed | Completed? | Failure Cause |
|-----|:-:|:-:|:-:|:-:|---|
| 172 | 4 (createFolder + rename × 3) | Yes (4>3) | 0 | N | no-progress |
| 173 | 4 (createFolder + rename × 3) | Yes (4>3) | 0 | N | no-progress |
| 174 | 4 (createFolder + rename × 3) | Yes (4>3) | 0 | N | no-progress |
| 175 | 4 (createFolder + rename × 3) | Yes (4>3) | 0 | N | no-progress |
| 176 | 4 (createFolder + rename × 3) | Yes (4>3) | 0 | N | no-progress |
| 177 | 6 (createFolder + rename × 5) | Yes (6>3) | 0 | N | no-progress |
| **178** | **3+3** (createFolder + rename × 2, then rename × 3) | **No (3≤3)** | **6** | **Y** | — |

**Original runs 165-171**: all proposed exactly 3 actions — would have been allowed at limit=3.

## Causal Chain

### When model proposes ≤3 actions (1 of 7 attempts — Run 178):

```txt
Step 0: listDirectory        (inspection, noProgress=1)
Step 1: listDirectory(items) (inspection, noProgress=2 → warning)
Step 2: createFolder + rename × 2  [3 actions ≤ 3 → ALLOWED]
Step 3: rename × 3                 [3 actions ≤ 3 → ALLOWED]
→ 6 mutations executed
→ Completed
```

### When model proposes 4+ actions (6 of 7 attempts):

```txt
Step 0: listDirectory        (inspection, noProgress=1)
Step 1: listDirectory(items) (inspection, noProgress=2 → warning)
Step 2: createFolder + rename × 3+  [4+ actions > 3 → SUPPRESSED]
Step 3: listDirectory        (noProgress=3 → TERMINATED)
→ 0 mutations executed
```

## Answer to the Question

**Original hypothesis**: The failure chain was `mutating_action_limit → no-progress → failure`.

**Experimental confirmation**:

- For the **original runs 165-171** (3-action proposals): raising the limit to 3 **would have eliminated the mutating_action_limit suppression**, allowing the 3 correct mutations to execute. All 6 original runs would likely have succeeded (analogous to Run 178).
- The model is **non-deterministic**: the same prompt produces 3 actions in some runs and 4-6 actions in others. At limit=3, only the 3-action variants succeed (1/7 in this sample).
- The no-progress detection **never independently caught a stuck model** in any of the 13 observations (6 original + 7 replay). It always terminated runs destabilized by the mutating action limit.
- Even at limit=3, failures remain when the model proposes 4+ actions — the no-progress detector still kills those runs. The control that determines success/failure is **how many actions the model happens to generate**, not the model's correctness.

## Counterfactual

If `MAX_MUTATING_ACTIONS_PER_RESPONSE` had been 3 in the original runs:

- Runs 165-171 (6 runs): all proposed 3 actions → all 3 would have been allowed → **6/6 likely completed**.
- Run 178 in this experiment demonstrates the exact mechanism working.
- The original benchmark's 6/6 no-progress failure rate would drop to 0/6.

Raising the limit from 2 to 3 does not eliminate the failure mode entirely (the model still sometimes proposes 4+ actions), but it **does** eliminate the failure mechanism for the specific 3-action pattern the original runs exhibited.
