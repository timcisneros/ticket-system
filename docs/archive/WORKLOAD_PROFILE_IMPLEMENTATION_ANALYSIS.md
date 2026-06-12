# Workload Profile Implementation Analysis

## Method

Analyzed the current Workload Profile implementation in `server.js` (lines 92-162, 7355-7460, 4308-4324, 5905-5948, 8837-8851) against the 100-scenario corpus from `SCENARIO_PRODUCT_FIT_EVALUATION.md` and `SCENARIO_PRODUCT_FIT_REEVALUATION.md`.

No new architecture, product concepts, or features are proposed. This is an evaluation of the existing implementation only.

---

## 1. What Signals Are Used to Classify Work?

The `detectWorkloadProfile(objective)` function (line 7355) uses **regex keyword matching on the free-text objective string** (lowercased). There is no semantic parsing, no intent classification, no structured input. Classification is entirely lexical.

### Detection Order (first match wins):

| Profile | Regex Pattern | Priority |
|---|---|---|
| `diagnosis` | `\b(diagnos\|bug\|failing test\|incorrect assertion\|test failure\|which test\|fix test\|broken test)\b` | 1st |
| `refactor` | `\b(move\|rename\|restructur\|refactor\|reorganize\|archive\|consolidate)\b` | 2nd |
| `recommendation` | `\b(recommend\|top [0-9]+\|improvement\|critical issue\|action item\|fix plan\|roadmap)\b` | 3rd |
| `bulk-inventory` | `\b(list all\|catalog\|inventory\|enumerate\|all files\|all directories\|every file\|full list)\b` | 4th |
| `report` | `\b(report\|summary\|synthesis\|overview\|analysis\|status\|audit)\b` | 5th (catch-all) |
| `null` | No match | Fallback |

### Characteristics of the Signal:

- **Single signal source:** Only the objective string. No ticket metadata, no agent configuration, no workspace state, no historical pattern.
- **No disambiguation:** "Analyze the bug report" matches `diagnosis` ("bug" > "report"). "Audit and refactor the codebase" matches `diagnosis` (nothing), then `refactor` ("refactor" > "audit"). Order determines classification, not work type semantics.
- **No confidence score:** Binary match/no-match. No indication of classification certainty.
- **Fragile to phrasing:** "List the top 10 issues" matches `recommendation` ("top [0-9]+"). "List all files" matches `bulk-inventory`. "List issues" matches nothing (falls to `report` if "analysis" is present, otherwise `null`).
- **No negative signals:** There is no mechanism to reject a match. "This is NOT a report" would still match `report`.

---

## 2. What Behaviors Actually Change After Classification?

When a profile is detected, three things change:

### A. Runtime Limits (enforced in the execution loop)

| Limit | `report` | `diagnosis` | `refactor` | `recommendation` | `bulk-inventory` |
|---|---|---|---|---|---|
| `maxExecutionSteps` | 12 | 12 | 12 | 12 | 16 |
| `maxModelRequestsPerRun` | 8 | 8 | 8 | 8 | 10 |
| `maxWorkspaceOperationsPerRun` | 32 | 24 | 24 | 24 | 40 |
| `maxListDirectoryPerRun` | 3 | 2 | 2 | 2 | 8 |
| `maxReadFilePerRun` | 8 | 6 | 4 | 6 | 4 |

Observations:
- `executionStepLimit` and `modelRequestLimit` are identical for 4 of 5 profiles (12/8). Only `bulk-inventory` differs (16/10).
- The meaningful variation is in `maxListDirectoryPerRun` and `maxReadFilePerRun`.
- These limits are **capped against base limits** (`Math.min`), not overriding them. If base limits are lower, the profile cannot raise them.

### B. Allowed Operations (subset of global operations)

| Profile | Operations |
|---|---|
| All except `refactor` | `listDirectory`, `readFile`, `writeFile`, `createFolder` |
| `refactor` | `listDirectory`, `readFile`, `renamePath`, `createFolder`, `deletePath` |

Observations:
- Only `refactor` differs. It swaps `writeFile` for `renamePath` and `deletePath`.
- `writeFile` is missing from `refactor`, which means a refactor task cannot produce a log or summary file. This is likely a bug (refactors often need documentation).
- All other profiles have identical operation sets.

### C. Prompt Guidance Injected into Agent Context

The `buildProfileGuidance(objective)` function (line 7402) returns an array of strings added to the agent's system prompt.

Common to all profiles:
- Profile name and description
- `maxListDirectory` and `maxReadFile` caps
- Expected phase pattern (all but `refactor` say `planning → inspection → mutation`; `refactor` says `planning → inspection → mutation → verification`)
- `finalArtifactRequired` flag (all true except `refactor`)

Profile-specific additions:
- `report`: "Cite specific file paths", "Do not create multiple report files"
- `diagnosis`: "Focus on root cause", "Explain why each assertion is incorrect"
- `refactor`: Extensive 4-phase behavioral guidance (DISCOVER → MUTATE → VERIFY → COMPLETE) with explicit instructions for each phase. This is the only profile with genuine behavioral orchestration.
- `recommendation`: "Prioritize most critical issues", "Link each recommendation to specific evidence"
- `bulk-inventory`: "Avoid listing every subdirectory", "Produce one summary writeFile"

### D. Runtime Envelope Exposure

The profile name and description are exposed in the `runtimeEnvelope` (line 5946), but the agent is not required to reference them. The guidance is advisory.

### Assessment of Behavioral Change Depth

| Dimension | Depth |
|---|---|
| **Runtime enforcement** | Real but shallow. Numeric caps on two operation types (`listDirectory`, `readFile`). Step and request limits vary only for `bulk-inventory`. |
| **Operation gating** | Minimal. Only `refactor` has a different operation set, and it arguably lacks `writeFile`. |
| **Prompt guidance** | Real but uneven. `refactor` has extensive behavioral orchestration. Other profiles have 2-3 generic lines of advice. |
| **Phase enforcement** | No. The "expected phase pattern" is advisory text. Phase transitions are controlled by a separate hardcoded state machine (`EXECUTION_PHASES`, `ALLOWED_PHASE_TRANSITIONS`) that does not consult workload profiles. |
| **Adaptive replanning** | None. Profiles are static for the entire run. No dynamic reclassification based on observed behavior. |
| **Model or temperature selection** | None. All profiles use the same model with the same parameters. |
| **Workspace fixture selection** | None. Profiles do not influence workspace setup. |

**Conclusion on behavioral change:** Adaptive execution is **partially real but mostly superficial**. The enforcement is genuine (limits are checked, guidance is injected), but the behavioral differences between profiles are small: mostly numeric caps on directory/file reads and a few prompt sentences. Only the `refactor` profile implements a genuinely distinct behavioral model.

---

## 3. What Important Work Patterns from the 100-Scenario Corpus Are Not Represented?

Of 100 realistic business scenarios, only **6 matched a workload profile** in the literal evaluation:

- 4 matched `report` (audit/status report scenarios)
- 1 matched `diagnosis` (diagnose inventory 503 errors)
- 1 matched `refactor` or `bulk-inventory` (none explicitly in the corpus)

The remaining **94 scenarios** represent work patterns with no profile representation:

### Pattern 1: Policy and Procedure Drafting (9 scenarios)
Examples: Draft HIPAA retention policy (12), Draft returns policy (34), Curate fair housing procedures (93), Curate sepsis detection protocol (71), Curate academic integrity policy (82).

**Why unrepresented:** These tasks involve synthesizing regulations and requirements into governing documents. They are write-heavy, not inspection-heavy. No profile maps to "draft policy from requirements." The `report` catch-all might trigger on "audit" or "status" but not on "draft policy" or "curate procedures."

### Pattern 2: Reconciliation (6 scenarios)
Examples: Reconcile ledger with settlement reports (5), Reconcile shipping manifests (24), Reconcile front/back office trades (45), Reconcile property tax with valuation (88).

**Why unrepresented:** These tasks require comparing two or more document sets and identifying discrepancies. They need read-heavy access to multiple files, structured comparison logic, and a discrepancy report. No profile captures "compare file A to file B and identify differences."

### Pattern 3: Planning and Scoping (16 scenarios)
Examples: Scope CRM replacement (6), Scope predictive maintenance (25), Scope FDA post-market surveillance (67), Scope first-party data strategy (100).

**Why unrepresented:** These tasks synthesize requirements, constraints, and options into a scoped plan document. They are research + synthesis tasks, not inspection + summary tasks. The `recommendation` profile is close but focuses on "top N issues" from existing files, not green-field scoping from reference materials.

### Pattern 4: File Organization and Archival (many scenarios)
Examples: Preserve acquisition record (10), Curate on-call knowledge base (18), Curate training knowledge (30), Curate fraud detection playbook (50), Curate evacuation procedures (60).

**Why unrepresented:** These are organizational tasks: sorting, categorizing, moving files into structures, creating indices. The `refactor` profile handles move/rename but assumes a single restructuring operation, not ongoing curation and organization.

### Pattern 5: Risk Assessment (many scenarios)
Examples: Assess Black Friday risk (7), Assess cold-chain market risk (26), Assess crypto custody risk (47), Assess gene therapy risk (68), Assess shopping center acquisition risk (90).

**Why unrepresented:** Risk assessment involves reading data, applying a rubric or framework, and producing a structured risk rating. The `report` profile might trigger on "assess" (does not match), but the guidance is generic. There is no risk-specific behavior.

### Pattern 6: Investigation (file-based, non-bug)
Examples: Investigate payment gateway rejections (1), Investigate delivery complaints spike (33), Investigate duplicate enrollment (74), Investigate marketing platform duplicate emails (96), Investigate property management rent roll (85).

**Why unrepresented:** The `diagnosis` profile only matches bug/test failure keywords. General investigations (pattern finding in logs, transaction analysis, data anomaly detection) do not match any regex.

### Pattern 7: Decision Support (8 scenarios)
Examples: Finalize go/no-go decision (20), Finalize promotion launch (40), Resolve DevOps/Security escalation (19).

**Why unrepresented:** These require structured evaluation against criteria, option comparison, and recommendation with dissent logging. The `recommendation` profile is close but focuses on "top N issues from files," not "evaluate options against weighted criteria."

### Summary of Coverage Gap

| Work Pattern | Scenario Count | Profile Coverage |
|---|---|---|
| Document analysis/report | 21 | `report` (partial) |
| Planning/scoping | 16 | None |
| Reconciliation | 6 | None |
| Policy drafting | 9 | None |
| Risk assessment | ~10 | None |
| File organization | ~8 | `refactor` (partial) |
| Investigation (non-bug) | ~8 | None |
| Decision support | 8 | `recommendation` (partial) |
| Refactor/restructure | ~3 | `refactor` |
| Diagnosis (bug/test) | ~2 | `diagnosis` |
| Inventory/catalog | ~1 | `bulk-inventory` |

**Finding:** The profile system covers at most **10-12%** of the realistic scenario corpus. The remaining **88-90%** of work patterns have no profile representation.

---

## 4. Which Existing Profiles Appear Redundant?

### Redundancy Pair A: `report` and `recommendation`

| Dimension | `report` | `recommendation` |
|---|---|---|
| Runtime limits | 12/8/32/3/8 | 12/8/24/2/6 |
| Allowed operations | Same | Same |
| Phase pattern | Same | Same |
| `finalArtifactRequired` | True | True |
| Prompt guidance | "Cite file paths, one artifact" | "Prioritize critical issues, link to evidence" |

**Analysis:** The behavioral differences are minimal. `recommendation` has slightly tighter `maxWorkspaceOperations` (24 vs 32) and `maxListDirectory` (2 vs 3), but these are subtle. The prompt guidance differs by 2 sentences. Both profiles instruct the agent to inspect files and write an artifact. In practice, a recommendation *is* a type of report.

**Verdict:** `recommendation` is a thin specialization of `report`. The distinction is not operationally significant enough to justify a separate profile.

### Redundancy Pair B: `report` and `diagnosis`

| Dimension | `report` | `diagnosis` |
|---|---|---|
| Runtime limits | 12/8/32/3/8 | 12/8/24/2/6 |
| Allowed operations | Same | Same |
| Phase pattern | Same | Same |
| `finalArtifactRequired` | True | True |
| Prompt guidance | "Cite file paths, one artifact" | "Root cause, explain incorrect assertions" |

**Analysis:** Again, the differences are minor. `diagnosis` has slightly lower limits, but the core behavior is identical: read files, analyze, write findings. A diagnosis *is* a specialized report.

**Verdict:** `diagnosis` is a thin specialization of `report`. The keyword distinction ("bug" vs "report") does not produce meaningfully different execution behavior.

### Redundancy Pair C: `bulk-inventory` and `report`

| Dimension | `bulk-inventory` | `report` |
|---|---|---|
| Runtime limits | 16/10/40/8/4 | 12/8/32/3/8 |
| Allowed operations | Same | Same |
| Phase pattern | Same | Same |
| `finalArtifactRequired` | True | True |

**Analysis:** `bulk-inventory` is the only profile with substantially different limits (higher steps, requests, operations, listDirectory). But the behavioral guidance is nearly identical to `report`: inspect, then write a summary. The only difference is the scale of listing.

**Verdict:** `bulk-inventory` is a scale variant of `report`, not a distinct work type. The higher listing limits are appropriate, but the profile does not represent a different behavioral model.

### Overall Redundancy Assessment

Of the 5 profiles, **3 are redundant with `report`** (`diagnosis`, `recommendation`, `bulk-inventory` as scale variant). Only `refactor` has a genuinely distinct behavioral model (different operations, phased guidance, no artifact requirement).

---

## 5. Which Profiles Appear Overloaded?

### `report` — Severely Overloaded

The `report` profile is the catch-all fallback (last regex to check). It matches:
- "report" — traditional summary reports
- "summary" — brief summaries
- "synthesis" — combining multiple sources
- "overview" — high-level descriptions
- "analysis" — detailed examination
- "status" — current state documentation
- "audit" — compliance verification reports

These are **7 distinct work patterns** with different optimal behaviors:
- A **status report** might need minimal reading and frequent writing (updates).
- An **audit** might need exhaustive reading and strict evidence citation.
- A **synthesis** might need reading many sources and combining them.
- An **analysis** might need iterative hypothesis testing.
- An **overview** might need minimal reading and high-level summary.

All of these receive the same runtime limits, same phase pattern, and same generic guidance. The `report` profile is doing the work of many distinct profiles and is therefore **operationally overloaded**.

### `refactor` — Moderately Overloaded

The `refactor` profile matches:
- "move" — moving files between directories
- "rename" — renaming files
- "restructur" — restructuring code or folders
- "refactor" — code refactoring
- "reorganize" — reorganization
- "archive" — archiving old files
- "consolidate" — consolidating multiple sources

These are **7 distinct operations** with different safety requirements:
- **Move/rename** needs verification that source is empty after operation.
- **Restructure** needs planning of target hierarchy.
- **Archive** needs preservation of original state.
- **Consolidate** needs merging of content, not just path changes.

The profile handles all of these with the same 4-phase guidance and the same operation set. It is overloaded but less severely than `report` because the operations are more similar (all involve path changes).

### `diagnosis` — Narrowly Scoped but Keyword-Fragile

The `diagnosis` profile is narrowly scoped to bugs and test failures. It does not match:
- Data quality issues ("find duplicate records")
- Performance degradation ("identify slow queries")
- Anomaly detection ("find outliers in sales data")
- Root cause analysis of non-software problems ("why are shipments delayed?")

It is **underloaded** in terms of coverage but **overly specific** in its keyword matching. A single "investigate" task might be a diagnosis, but the regex won't catch it.

---

## 6. Overall Assessment: Is Adaptive Execution Real or Mostly Superficial?

### What Is Real:

1. **Enforced runtime limits:** `maxListDirectoryPerRun` and `maxReadFilePerRun` are genuinely enforced in the execution loop (lines 8837-8851). Agents that exceed these limits throw `RUN_LIMIT_EXCEEDED` errors.
2. **Prompt injection:** Profile-specific guidance is genuinely injected into the agent context. The model receives different instructions for different profiles.
3. **Operation subsetting:** `refactor` genuinely restricts the available operations (though the restriction may be buggy — missing `writeFile`).
4. **`refactor` behavioral orchestration:** The 4-phase DISCOVER → MUTATE → VERIFY → COMPLETE guidance for `refactor` is a real attempt at behavioral adaptation.

### What Is Superficial:

1. **Classification signal:** Regex keyword matching on objective text is a superficial signal. It has no semantic understanding, no confidence, and is fragile to phrasing.
2. **Behavioral differentiation:** 4 of 5 profiles (`report`, `diagnosis`, `recommendation`, `bulk-inventory`) have nearly identical behaviors: read files, write artifact, stay within numeric caps. The differences are small variations in read limits and 2-3 sentences of prompt guidance.
3. **Phase enforcement:** The "expected phase pattern" is advisory text. The actual phase state machine (`EXECUTION_PHASES`, `ALLOWED_PHASE_TRANSITIONS`) is hardcoded and profile-agnostic.
4. **Dynamic adaptation:** Profiles are static for the entire run. There is no observation of agent behavior that triggers profile adjustment, no feedback loop, no reclassification mid-run.
5. **Coverage:** The profile system covers approximately **10-12%** of realistic business scenarios. The other 88-90% of work patterns receive no adaptive behavior at all (they fall through to default limits or null profile).

### Conclusion

**Adaptive execution is real but superficial.**

The mechanism exists and is enforced, but the adaptation is shallow:
- The signal is lexical, not semantic.
- The behavioral differences are numeric caps and generic prompt text, not genuinely distinct execution strategies.
- Only one profile (`refactor`) implements a distinct behavioral model.
- The system leaves ~90% of realistic work patterns completely unadapted.

The Workload Profile implementation is a **first-generation adaptive layer**: it proves the concept that different work types can have different runtime parameters, but it does not yet deliver meaningful behavioral differentiation for the breadth of work the product encounters.
