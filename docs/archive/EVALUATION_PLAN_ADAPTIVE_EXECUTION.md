# Evaluation Plan: Adaptive Execution Outcome Quality

## Overview

Determine whether the current Workload Profile implementation materially improves outcome quality for realistic business work. The evaluation uses only the existing system, existing profiles, and the 100-scenario corpus. No new profiles, architecture, or implementation.

---

## 1. Ticket Selection: 10 Realistic Scenarios from the Corpus

Selected from `SCENARIO_PRODUCT_FIT_EVALUATION.md`. All 10 are within the product's current scope (file-based document analysis, drafting, or reconciliation). Five naturally trigger a current Workload Profile. Five do not.

### Treatment Group (Profile-Triggering)

Run each ticket **twice**: once with profile detection enabled (adaptive), once with profile detection disabled (non-adaptive, receives default limits).

| # | Scenario ID | Objective (as written) | Triggered Profile |
|---|---|---|---|
| T1 | #2 | "Audit GDPR compliance across all customer-facing services" | `report` (matches "audit") |
| T2 | #3 | "Diagnose inventory 503 errors in the warehouse API" | `diagnosis` (matches "diagnos") |
| T3 | #27 | "Factory floor safety audit status report" | `report` (matches "audit", "report") |
| T4 | #57 | "Campus sustainability status report" | `report` (matches "status", "report") |
| T5 | #75 | "Audit FERPA procedures in student information systems" | `report` (matches "audit") |

### Control Group (Non-Profile)

Run each ticket **once**. These objectives contain no keywords that match any current profile regex. They serve as a baseline to verify the measurement methodology is sensitive enough to detect quality differences at all.

| # | Scenario ID | Objective (as written) | Triggered Profile |
|---|---|---|---|
| C1 | #4 | "Quarterly risk assessment for payment processing" | `null` |
| C2 | #5 | "Reconcile ledger with processor settlement reports" | `null` |
| C3 | #12 | "Draft HIPAA retention policy for patient records" | `null` |
| C4 | #24 | "Reconcile shipping manifest with carrier delivery confirmations" | `null` |
| C5 | #34 | "Draft returns policy aligned with consumer protection law" | `null` |

**Total runs:** 15 (10 treatment pairs + 5 control singles).

---

## 2. How Outcome Quality Is Measured

Two measurement layers: automated metrics and human rubric scoring.

### Layer A: Automated Metrics (objective, no human judgment)

| Metric | Source | Measurement |
|---|---|---|
| **Completion Status** | Run record | Did the run reach `completed` state? (`true`/`false`) |
| **Artifact Presence** | Operation history | Did the run execute at least one `writeFile`? (`true`/`false`) |
| **Termination Cause** | Events + run record | Natural completion, step limit, operation limit, model request limit, timeout, or error? |
| **Operation Efficiency** | Operation history | Count of `listDirectory`, `readFile`, `writeFile`. Ratio of read operations to write operations. |
| **Profile Adherence** | Events | Did the run stay within the profile-specific `maxListDirectory` and `maxReadFile` caps? |

### Layer B: Human Rubric Scoring (structured, blinded)

Each run's final output (the written file, or the agent's final text if no file) is evaluated by a human reviewer who does not know whether the run was adaptive or non-adaptive.

| Criterion | Scale | Definition |
|---|---|---|
| **Objective Coverage** | 0–3 | 3: All parts of the objective addressed. 2: Most parts addressed. 1: Some parts addressed. 0: Objective ignored or unaddressed. |
| **Output Quality** | 0–3 | 3: Coherent, well-structured, accurate, actionable. 2: Coherent but with gaps or minor errors. 1: Fragmented, poorly structured, or contains errors. 0: No usable output. |
| **Evidence Quality** | 0–2 | 2: Specific citations to inspected files. 1: General references to source material. 0: No evidence or invented claims. |

**Scoring procedure:**
- Reviewer reads the ticket objective.
- Reviewer reads the run output (file content or final agent text).
- Reviewer assigns scores independently for each criterion.
- Reviewer notes any observable differences between adaptive and non-adaptive pairs (without knowing which is which).

---

## 3. How Adaptive Behavior Is Compared Against Non-Adaptive Behavior

### Experimental Design

For each treatment ticket (T1–T5):
- **Adaptive run:** Profile detection enabled. The system applies `getProfileRuntimeLimits` and injects `buildProfileGuidance` into the prompt.
- **Non-adaptive run:** Profile detection disabled. The `detectWorkloadProfile` function is bypassed (returns `null`). The system uses `DEFAULT_AGENT_RUNTIME_LIMITS` with no profile guidance injected.
- Both runs use the **same agent**, **same workspace fixture**, and **same ticket objective**.
- Runs are executed in randomized order to prevent ordering bias.

For each control ticket (C1–C5):
- **Baseline run:** Normal execution. Since no profile is detected, this is equivalent to the non-adaptive condition.
- These establish the baseline quality distribution for work that receives no adaptive behavior.

### Comparison Methodology

**Within-pair comparison (primary):**
For each treatment pair (T1 adaptive vs T1 non-adaptive, etc.), compute the delta on each metric:
- `ΔCompletion = AdaptiveCompletion − NonAdaptiveCompletion`
- `ΔCoverage = AdaptiveCoverageScore − NonAdaptiveCoverageScore`
- `ΔQuality = AdaptiveQualityScore − NonAdaptiveQualityScore`
- `ΔEvidence = AdaptiveEvidenceScore − NonAdaptiveEvidenceScore`

**Across-group comparison (secondary):**
Compare the distribution of treatment-pair adaptive scores against the control-group baseline scores. If adaptive execution helps, the adaptive runs should outperform the control baseline. If adaptive execution is irrelevant, the adaptive runs should resemble the control baseline.

**Aggregation:**
- Report mean, median, and range of deltas across the 5 treatment pairs.
- Report proportion of pairs where adaptive outperforms non-adaptive on each metric.
- Report confidence intervals where sample size permits.

---

## 4. What Evidence Would Demonstrate Meaningful Improvement

Adaptive execution is considered to materially improve outcome quality if **all three** of the following hold:

### Criterion A: Consistent Within-Pair Improvement
At least **4 of 5 treatment pairs** show adaptive runs scoring higher than their non-adaptive counterparts on **Objective Coverage** (ΔCoverage > 0).

### Criterion B: Measurable Quality Delta
The mean `ΔQuality` across 5 treatment pairs is **≥ +0.5** on the 0–3 scale (equivalent to moving from "acceptable with gaps" to "coherent and accurate" on average).

### Criterion C: Operational Efficiency
Adaptive runs show **lower limit-exhaustion rates** than non-adaptive runs on at least **4 of 5 pairs**, specifically:
- Fewer `RUN_LIMIT_EXCEEDED` errors on `listDirectory` or `readFile`.
- Fewer premature terminations due to step or operation limits.

**Supporting evidence (not required, but strengthening):**
- Control group (C1–C5) scores cluster with the non-adaptive treatment runs, confirming the profile (not just the ticket type) is the differentiator.
- `refactor`-like profiles (if any were in the treatment set) show the largest behavioral deltas, consistent with the finding that `refactor` is the only materially distinct profile.
- Reviewer blinded notes indicate the adaptive outputs are "more focused" or "better scoped" without knowing which is which.

---

## 5. What Evidence Would Demonstrate No Improvement

Adaptive execution is considered to provide no material improvement if **any one** of the following holds:

### Null Hypothesis A: No Within-Pair Difference
At least **3 of 5 treatment pairs** show **no difference** (Δ = 0) or **non-adaptive outperforming adaptive** (Δ < 0) on Objective Coverage.

### Null Hypothesis B: Negligible Quality Delta
The mean `ΔQuality` across 5 treatment pairs is **< +0.3** on the 0–3 scale. A delta below 0.3 is within typical inter-rater noise and is not operationally meaningful.

### Null Hypothesis C: Limit Exhaustion Is Not Reduced
Adaptive runs do not show reduced limit-exhaustion rates. Specifically:
- Non-adaptive runs hit limits at the same or lower rate than adaptive runs on **≥3 of 5 pairs**.
- OR: Both adaptive and non-adaptive runs complete successfully on most pairs, suggesting limits are not the binding constraint.

### Null Hypothesis D: Control Group Parity
The adaptive treatment runs perform **no better than the control group baseline** (C1–C5) on average. If profile-triggering work gets no quality advantage over non-profile work, the adaptive layer is ineffective.

**Supporting evidence for null (not required, but strengthening):**
- Reviewer notes that adaptive and non-adaptive outputs are "indistinguishable" or "both hit the same ceiling."
- Automated metrics show identical operation counts and file outputs between adaptive and non-adaptive pairs.
- The primary variation in outcomes is attributable to agent model quality or workspace state, not profile presence.

---

## 6. Execution Constraints

- **No new profiles:** Only `report`, `diagnosis`, `refactor`, `recommendation`, `bulk-inventory` may be triggered.
- **No system changes:** The evaluation must be runnable on the current codebase without modifications.
- **Profile bypass:** For non-adaptive runs, the evaluator sets the ticket objective to a string that does not trigger any profile, or temporarily bypasses `detectWorkloadProfile` at the evaluation harness level. No runtime code changes.
- **Human scoring:** One independent reviewer, blinded to condition, scores all 15 outputs. A second reviewer scores a subset (e.g., 5 runs) to compute inter-rater reliability.
- **Workspace isolation:** Each run uses a fresh workspace or a reproducible fixture to prevent cross-run contamination.

---

## 7. Expected Duration

| Phase | Effort |
|---|---|
| Setup (workspace fixtures, harness) | 1 hour |
| Run execution (15 runs × ~5 min each) | 2 hours |
| Human scoring (15 outputs × ~10 min each) | 3 hours |
| Inter-rater reliability check | 1 hour |
| Analysis and reporting | 1 hour |
| **Total** | **~8 hours** |

---

## 8. Deliverables

1. Raw scores spreadsheet: 15 runs × 7 metrics (completion, artifact, coverage, quality, evidence, termination cause, limit adherence).
2. Delta table: 5 treatment pairs × 4 delta metrics.
3. Blinded reviewer notes for each output.
4. Conclusion statement: whether the evidence supports meaningful improvement, no improvement, or is inconclusive.

---

## Summary

This evaluation plan tests the only claim that matters: **do the current Workload Profiles make outcomes better?**

It does so by:
- Selecting realistic work from the accepted scenario corpus.
- Running the same work with and without profiles (paired comparison).
- Measuring both automated outcomes and human-judged quality.
- Defining clear thresholds for "meaningful" vs "no" improvement.
- Leaving no ambiguity about what would validate or invalidate adaptive execution as currently implemented.
