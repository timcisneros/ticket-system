# Principle Promotion Process

## Purpose

Document the promotion process that emerged from the Evidence Preservation investigation (Runs 77–82, Ticket #59). This process determines when a candidate principle graduates from observation to invariant.

The process is manual, evidence-driven, and requires direct causal validation. No automation, no workflow engine, no tooling.

---

## Process Overview

```
Observation
    ↓
Analysis
    ↓
Experiment
    ↓
Validated Improvement
    ↓
Candidate Principle
    ↓
Promotion Review
    ↓
Invariant
```

Each stage has entry criteria (what must exist to enter), exit criteria (what must be true to leave), and required evidence (what must be documented).

---

## Stage 1: Observation

### Description
A behavior is noticed that deviates from expected substrate performance. This may be a failure, a contradiction, a confusing model choice, or an unexpected replay pattern.

### Entry criteria
- A run, replay, or event sequence exhibits behavior that is not explained by existing invariants
- The behavior is reproducible or appears in multiple runs

### Exit criteria
- The observation is documented with exact evidence (run IDs, replay snapshots, event lines, prompt text)
- The observation is stripped of assumption (e.g., "model is bad" is not evidence; "model received X and emitted Y" is evidence)

### Required evidence
| Artifact | Content |
|----------|---------|
| Run ID(s) | Specific runs where the behavior occurred |
| Replay snapshot | Parsed prompt text, action results, model response |
| Event lines | Relevant events from `data/events.jsonl` |
| Prompt text | Exact system prompt and user messages sent to the model |

### Reference example
**Run #77:** Model emitted `listDirectory` on step 0, then emitted `listDirectory` again on step 1. Run terminated with `run:step_limit`. The prompt contained contradictory authority signals. The `actionResults` array was overwritten with a no-progress warning.

---

## Stage 2: Analysis

### Description
The observation is decomposed into hypotheses. Each hypothesis proposes a root cause. The hypotheses are tested against the evidence. Wrong hypotheses are eliminated. Surviving hypotheses are ranked.

### Entry criteria
- Stage 1 evidence is complete and parsed
- At least two competing hypotheses exist (to prevent confirmation bias)

### Exit criteria
- Each hypothesis is evaluated against the evidence with a specific verdict: supported, contradicted, or undetermined
- The strongest hypothesis is identified
- Counterexamples to the strongest hypothesis are explicitly documented
- No implementation changes have been made yet

### Required evidence
| Artifact | Content |
|----------|---------|
| Hypothesis list | Each hypothesis with supporting and contradicting evidence |
| Code paths | Exact lines in `server.js` relevant to each hypothesis |
| Prompt construction trace | How the prompt was built, what fields were populated |
| Downstream consumer analysis | Who reads the affected data and what they expect |

### Reference example
**Hypothesis A:** The model is ignoring phase-gated guidance.
- Supported by: model repeated `listDirectory` in inspection phase
- Contradicted by: Runs 77/79/81 received the same guidance; some runs should have passed by chance if the model randomly obeyed

**Hypothesis B:** The prompt contains contradictory authority signals.
- Supported by: prompt told model to trust `runtimeEnvelope.allowedOperations` (full catalog) while also restricting to phase subset
- Partial: prompt fix alone (Run #81) did not resolve the failure

**Hypothesis C (winner):** Evidence destruction prevented transition guidance from firing.
- Supported by: `buildTransitionGuidance` requires `.action` and `.result` fields; `actionResults` was overwritten with warning; model received scolding but no "inspection complete" signal
- Direct: preserving the result allows `buildTransitionGuidance` to fire

---

## Stage 3: Experiment

### Description
A minimal change is made to test the strongest hypothesis. The change must enact the proposed principle directly. No new concepts, no new abstractions, no new runtime semantics.

### Entry criteria
- Stage 2 analysis identifies a specific, testable hypothesis
- The change is a single-line or few-line modification to existing code
- The change does not introduce new state, new phases, new evidence types, or new enforcement behavior

### Exit criteria
- The change is implemented
- Syntax check passes (`npm run build`)
- Targeted tests pass
- The change is deployed to a running server

### Required evidence
| Artifact | Content |
|----------|---------|
| Diff | Exact code change |
| Build output | `npm run build` passes |
| Test output | Targeted test results |
| Server restart | Fresh process running the changed code |

### Reference example
**Option B:** Changed `actionResults = [{warning}]` to `actionResults.push({warning})` on line 9078.
- Build passed
- `phase-gated-catalog-behavioral-test.js` passed (5/5)
- `organization-guidance-test.js` passed (10/10)
- Server restarted with new code

---

## Stage 4: Validated Improvement

### Description
The experiment is exercised against the same workload that produced the original observation. The outcome is compared directly. Improvement must be measurable and attributable to the change.

### Entry criteria
- Stage 3 experiment is deployed
- The original failing workload is available and runnable
- The outcome can be observed (run completion or failure)

### Exit criteria
- The new run completes successfully where the old runs failed, OR
- The new run exhibits the hypothesized behavioral change even if it still fails (partial validation), OR
- The new run fails identically, falsifying the hypothesis

### Required evidence
| Artifact | Content |
|----------|---------|
| New run ID | Run executed with the changed code |
| Replay snapshot | Full prompt text and model responses from the new run |
| Comparison table | Before/after outcomes for identical model, ticket, and limits |
| Attribution check | No other variables changed (same model, same ticket, same limits) |

### Reference example
| Metric | Run #81 (before) | Run #82 (after) |
|--------|-----------------|-----------------|
| terminalStatus | `failed` | `completed` |
| Step 1 action | `listDirectory` (repeat) | `createFolder`, `createFolder` |
| Transition guidance | Absent | Present |
| Evidence | Destroyed | Preserved |

Improvement is binary and directly attributable to the single-line change.

---

## Stage 5: Candidate Principle

### Description
The validated improvement is generalized into a principle statement. The principle must be abstract enough to apply beyond the specific ticket, but concrete enough to be testable.

### Entry criteria
- Stage 4 validated improvement exists
- The change generalizes to a broader pattern (not just this one line)
- The principle is phrased as a "must" or "must not" statement

### Exit criteria
- Principle wording is drafted
- The principle is evaluated against existing invariants for redundancy
- Counterexamples are identified and resolved or documented

### Required evidence
| Artifact | Content |
|----------|---------|
| Principle statement | Single-sentence formulation |
| Generalization argument | Why this applies beyond the specific case |
| Redundancy check | Which existing invariant(s) might already cover this |
| Counterexamples | Cases where the principle would not apply or would be harmful |

### Reference example
**Draft A:** "Append evidence, do not replace evidence."
- Counterexample: action limit checks occur before execution where `actionResults` is already empty
- Resolution: The principle applies to post-execution evidence, not pre-execution rejection boundaries

**Draft B:** "Preserve useful evidence until downstream consumers have had an opportunity to use it."
- Counterexample: "useful" is vague; "opportunity" is vague
- Resolution: Rejected as too vague for an invariant

**Draft C (selected):** "Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers."
- No unresolved counterexamples

---

## Stage 6: Promotion Review

### Description
The candidate principle is evaluated against the invariant acceptance criteria. This is a higher burden of proof than the candidate stage.

### Entry criteria
- Stage 5 principle is drafted and internally consistent
- The principle has been tested through the Observation → Analysis → Experiment → Validated Improvement chain

### Exit criteria
- **Promote Now:** Direct regression + direct fix + direct improvement are all documented
- **Hold As Principle:** Strong architectural reasoning, but one or more of the three criteria are not met
- **Reject:** Principle is unsound, redundant, or violated by design

### Required evidence
| Criterion | Evidence required |
|-----------|-----------------|
| Direct regression | Exact runs or code where violating the principle caused failure |
| Direct fix | Exact code change that enacts the principle |
| Direct improvement | Before/after comparison showing the fix changed the outcome |
| Future validity | Reasoning about whether the principle holds under substrate evolution |
| Invariant independence | Whether existing invariants already cover this |

### Reference example: Evidence Preservation

| Criterion | Met? | Evidence |
|-----------|------|----------|
| Direct regression | Yes | Runs 77/79/81: `listDirectory` result destroyed, model repeated inspection |
| Direct fix | Yes | Option B: `push` instead of `=` on line 9078 |
| Direct improvement | Yes | Run #82 completed where 77/79/81 failed |
| Future validity | Yes | Applies to any feedback-loop substrate |
| Invariant independence | Yes | No existing invariant covers feedback-loop evidence destruction |

**Verdict: Promote Now.**

### Reference example: Authority Layer Separation

| Criterion | Met? | Evidence |
|-----------|------|----------|
| Direct regression | Partial | Prompt contradiction contributed to confusion but was not primary cause |
| Direct fix | Yes | Prompt wording changed on line 8368 |
| Direct improvement | No | Run #81 still failed after prompt fix; improvement came from Evidence Preservation |
| Future validity | Yes | Applies to authority-based systems |
| Invariant independence | Partial | Derivative of Invariant #2 (Preserve Abstractions) |

**Verdict: Hold As Principle.**

---

## Stage 7: Invariant

### Description
The principle is added to `docs/ARCHITECTURE_INVARIANTS.md` with a declarative statement and a brief rationale. It becomes part of the substrate's contract.

### Entry criteria
- Stage 6 verdict is "Promote Now"
- Wording is finalized

### Exit criteria
- `docs/ARCHITECTURE_INVARIANTS.md` is updated
- The invariant is numbered sequentially
- The invariant follows the declarative style of existing invariants
- `AGENTS.md` is updated if the invariant changes operational guidance for agents

### Required evidence
| Artifact | Content |
|----------|---------|
| Updated ARCHITECTURE_INVARIANTS.md | New invariant text |
| Git diff | Exact changes to the invariants file |
| Consistency check | New invariant does not contradict existing invariants |

### Reference example
**Evidence Preservation** was added as Invariant #9 on 2026-05-28:

> Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers. Enforcement warnings may be added to the feedback loop, but they must not overwrite the evidence that downstream logic depends on.

---

## Decision Authority

- **Observation, Analysis, Experiment:** Any operator or agent working on the substrate
- **Validated Improvement:** Requires at least one before/after run pair
- **Candidate Principle:** Requires documentation review
- **Promotion Review:** Requires all three Promote Now criteria to be met with direct evidence
- **Invariant:** Requires Promotion Review verdict of "Promote Now" and a consistency check against existing invariants

No committee. No voting. No approval workflow. The evidence is the authority.

---

## Process Integrity Checks

Before promoting any principle, verify:

1. **No new concepts:** Does the principle require adding new substrate concepts (new state types, new phases, new runtime fields)? If yes, it may be a feature, not an invariant.
2. **No implementation technique:** Is the principle about a specific coding pattern (e.g., "use `push` instead of `=`")? If yes, it is too mechanical. Generalize it.
3. **No optimization:** Is the principle about performance or resource usage? If yes, it is an optimization guideline, not an invariant.
4. **Causal chain:** Can you draw a direct arrow from violating the principle to a specific failure, and from enacting the principle to a specific improvement?
5. **Independence:** Does an existing invariant already cover this? If yes, document it as an extension, not a new invariant.

---

## Reference Documents

This process was exercised in the following document chain:

1. `docs/RUN_77_POSTMORTEM.md` — Observation and initial analysis
2. `docs/PHASE_GATED_ENVELOPE_ANALYSIS.md` — Hypothesis testing
3. `docs/ALLOWED_OPERATIONS_AUTHORITY.md` — Authority hypothesis elimination
4. `docs/PROMPT_AUTHORITY_ALIGNMENT.md` — Prompt contradiction analysis
5. `docs/PROMPT_AUTHORITY_ALIGNMENT_RESULTS.md` — Experiment (prompt fix only)
6. `docs/PHASE_AUTHORITY_OPTIONS.md` — Response validation analysis
7. `docs/INSPECTION_TO_MUTATION_ANALYSIS.md` — Root cause identification
8. `docs/INSPECTION_COMPLETION_SEMANTICS.md` — Option evaluation
9. `docs/OPTION_B_RESULTS.md` — Experiment (evidence preservation)
10. `docs/EVIDENCE_PRESERVATION_PRINCIPLE.md` — Candidate principle formulation
11. `docs/EVIDENCE_PRESERVATION_DECISION_MATRIX.md` — Remaining candidate analysis
12. `docs/SUBSTRATE_DESIGN_PRINCIPLES.md` — Principle consolidation
13. `docs/INVARIANT_PROMOTION_REVIEW.md` — Promotion review
14. `docs/INVARIANT_ACCEPTANCE_DECISION.md` — Acceptance decision

---

*This process is a record of what was done, not a mandate for what must be done. Future investigations may discover a different path from observation to invariant. The only non-negotiable requirement is evidence.*
