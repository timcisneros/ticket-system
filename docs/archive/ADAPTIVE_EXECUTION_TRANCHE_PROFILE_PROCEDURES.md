# Adaptive Execution Tranche: Profile-Specific Procedures

## Overview

Revised tranche design. All 5 existing profiles are preserved. The change is to replace shallow guidance with profile-specific structured procedures. The goal is to determine whether the existing taxonomy contains meaningful distinctions once procedures become real.

No architecture changes. No new profiles. No user-facing features.

---

## 1. What Changes

### Current State (Superficial)

Each profile injects:
- A name and description
- Numeric caps on `listDirectory` and `readFile`
- 2–3 generic advice sentences

Example (`report`):
```
This ticket matches the "report" workload profile: Inspection-heavy task producing a summary or analysis document.
Use at most 3 listDirectory calls total. Use at most 8 readFile calls total.
Expected phase pattern: planning → inspection → mutation.
Cite specific file paths you inspected. Do not invent file contents.
Do not create multiple report files. One report artifact per ticket.
```

### Target State (Procedural)

Each profile injects a **structured multi-phase procedure** that specifies:
- The exact reasoning sequence
- Per-phase operation constraints
- Completion criteria
- Failure mode

The runtime architecture (phase state machine, operation authorization, limit enforcement) remains unchanged. The procedure is injected as prompt text. The agent is expected to follow it.

---

## 2. Profile-Specific Procedures

### Profile: report

**Purpose:** Produce a descriptive summary or analysis document based on inspection of existing files.

**Procedure:**
```
You are executing a REPORT task. Follow this exact procedure:

Phase 1 — PLAN: State what the report must cover. Identify the 2–4 key questions the report must answer. Do not begin inspection until you have stated the plan.

Phase 2 — DISCOVER: Use listDirectory to locate relevant source files. Stop once you have found the primary sources. Do not list every subdirectory individually.

Phase 3 — INSPECT: Read the identified source files. Cite specific file paths in your reasoning. Do not invent file contents.

Phase 4 — SYNTHESIZE: Combine inspected evidence into a coherent narrative. Organize findings by the key questions identified in Phase 1.

Phase 5 — WRITE: Produce the report via writeFile. One report artifact per ticket. Include a "Sources Inspected" section listing all file paths read.

Phase 6 — VERIFY: Confirm the report file exists. Confirm it answers all key questions from Phase 1. If any question is unanswered, return to Phase 3.

Failure mode: If required source files do not exist, state this explicitly in the report and complete.
```

**Why this differs from other profiles:**
The report procedure is **descriptive and comprehensive**. It asks the agent to cover a topic broadly, cite all sources, and produce a single coherent artifact. The emphasis is on **coverage and accuracy**, not on identifying problems or proposing changes.

**Runtime behavior difference:**
The agent is expected to state a plan before inspecting, synthesize broadly across multiple sources, and verify that all stated questions are answered. This should produce outputs with a "Sources Inspected" section and broad coverage.

---

### Profile: diagnosis

**Purpose:** Read files to identify the root cause of a bug, test failure, or incorrect behavior.

**Procedure:**
```
You are executing a DIAGNOSIS task. Follow this exact procedure:

Phase 1 — REPRODUCE: Confirm the reported symptoms. Read the failing test, error log, or incorrect output. State the observed failure precisely.

Phase 2 — TRACE: Read the source code and related files to trace the execution path that leads to the failure. Follow the data flow from input to failure point.

Phase 3 — HYPOTHESIZE: Form a root cause theory. State what you believe is wrong and why, with evidence from the code.

Phase 4 — VERIFY: Check if your theory explains all observed symptoms. Read additional files if needed to confirm or reject the hypothesis. If the hypothesis is wrong, form a new one and repeat Phase 3–4.

Phase 5 — REPORT: Write a diagnosis document via writeFile. Structure: Observed Failure, Root Cause, Evidence, Confidence Level (High/Medium/Low). Cite specific file paths and line references.

Failure mode: If the root cause cannot be determined after exhausting relevant files, state the most likely hypothesis with confidence Low and complete.
```

**Why this differs from report:**
The diagnosis procedure is **analytical and focused**. It does not ask for broad coverage. It asks the agent to trace a specific failure, form a hypothesis, and verify it. The emphasis is on **root cause identification and evidence**, not on comprehensive description.

**Runtime behavior difference:**
The agent is expected to start with the failure symptom, trace backward through code, and form/test a hypothesis. This should produce outputs with a structured diagnosis format (Observed Failure, Root Cause, Evidence, Confidence) and specific line references, not broad summaries.

---

### Profile: recommendation

**Purpose:** Read files and produce an evidence-based improvement plan, ranked by priority.

**Procedure:**
```
You are executing a RECOMMENDATION task. Follow this exact procedure:

Phase 1 — SCOPE: Define the evaluation criteria. What dimensions will you assess? (e.g., performance, security, maintainability, correctness). State the criteria explicitly.

Phase 2 — INSPECT: Read the relevant files. Assess each file against the stated criteria. Record specific findings with file path evidence.

Phase 3 — ANALYZE: Convert findings into distinct issues. Group related findings. Deduplicate overlapping observations.

Phase 4 — PRIORITIZE: Rank issues by impact and effort. Identify the top 3–5 highest-value changes. Explain the prioritization rationale.

Phase 5 — RECOMMEND: For each prioritized issue, specify: What to change, Why it matters, Expected outcome, Evidence supporting the recommendation. Link each recommendation to specific file paths.

Phase 6 — WRITE: Produce the recommendation document via writeFile. Structure: Executive Summary, Criteria, Findings, Prioritized Recommendations, Evidence Appendix.

Failure mode: If no issues meet the criteria, state this explicitly and complete with a clean bill of health.
```

**Why this differs from report:**
The recommendation procedure is **evaluative and prescriptive**. It does not merely describe what exists. It assesses quality against criteria, identifies gaps, and proposes ranked changes. The emphasis is on **judgment and prioritization**, not on neutral description.

**Runtime behavior difference:**
The agent is expected to state evaluation criteria before inspecting, judge findings against those criteria, and produce a ranked list of actionable changes. This should produce outputs with an "Executive Summary" and "Prioritized Recommendations" section, not a neutral summary.

---

### Profile: bulk-inventory

**Purpose:** Systematically catalog directories and files across the workspace.

**Procedure:**
```
You are executing a BULK-INVENTORY task. Follow this exact procedure:

Phase 1 — DEFINE: State the inventory scope. What are you cataloging? (files, directories, types, sizes, dates). What is the output format?

Phase 2 — DISCOVER: Use listDirectory to map the workspace structure. Group related paths. Avoid listing every subdirectory individually; use patterns and summaries.

Phase 3 — SAMPLE: Read a representative sample of files to capture metadata (type, size, content category). Do not read every file. State your sampling rationale.

Phase 4 — CATALOG: Record the discovered structure and sample findings. Organize by category, location, or other logical grouping.

Phase 5 — WRITE: Produce the inventory report via writeFile. Include: Total counts, Structure summary, Sample details, Gaps or anomalies found.

Failure mode: If the workspace is empty or inaccessible, state this and complete with an empty inventory.
```

**Why this differs from report:**
The bulk-inventory procedure is **structural and systematic**. It focuses on workspace organization and file metadata, not on file content analysis. The emphasis is on **completeness of cataloging and efficient traversal**, not on understanding what files contain.

**Runtime behavior difference:**
The agent is expected to group paths, use summaries instead of individual listings, sample rather than read exhaustively, and produce a structured inventory with counts and anomalies. This should produce outputs with "Total counts" and "Structure summary" sections, not content analysis.

---

### Profile: refactor (preserved, enhanced)

**Purpose:** Move, rename, restructure, or reorganize files and folders.

**Procedure (existing, preserved with minor clarification):**
```
You are executing a REFACTOR task. Follow this exact procedure:

Phase 1 — DISCOVER: listDirectory the relevant directory ONCE. Identify every item that must be moved, renamed, or created. Do not list again in later steps.

Phase 2 — MUTATE: Use the discovered entries to emit bounded mutation batches. Do not repeat DISCOVER unless evidence is insufficient. Respect maxMutatingActionsPerResponse. If more mutations remain, continue with the next bounded mutation batch.

Phase 3 — VERIFY: listDirectory the affected directories to confirm items are in the correct locations. Check that no items remain at old locations. Verify only after at least one mutation batch has executed.

Phase 4 — COMPLETE: Set complete:true only after verification succeeds.

Failure mode: If no matching items exist at the source, state this clearly and complete after any required createFolder operations. If required paths or destinations cannot be determined, fail with an explicit reason. Do not enter a loop of repeated listDirectory calls.
```

**Why this differs from all others:**
The refactor procedure is **mutation-centric with verification**. It is the only profile where the primary work is changing the workspace structure, not producing a document. The emphasis is on **safe, bounded, verified structural changes**.

**Runtime behavior difference:**
The agent is expected to discover once, mutate in bounded batches, verify structure, and only then complete. This produces file system changes (moves, renames) with verification steps, not analysis documents.

---

## 3. Runtime Behavior Differences Between Profiles

The following table summarizes what the agent is instructed to do differently in each profile:

| Dimension | report | diagnosis | recommendation | bulk-inventory | refactor |
|---|---|---|---|---|---|
| **First action** | State plan (key questions) | Reproduce failure | State criteria | Define scope | Discover directory |
| **Primary operation** | readFile (content) | readFile (trace) | readFile (evaluate) | listDirectory (structure) | renamePath/deletePath |
| **Reasoning mode** | Descriptive synthesis | Hypothesis testing | Judgment + ranking | Systematic cataloging | Bounded batching |
| **Output structure** | Sources + narrative | Failure + root cause + confidence | Criteria + ranked changes | Counts + structure + anomalies | File system changes |
| **Completion criteria** | All questions answered | Hypothesis verified | Recommendations ranked | Catalog complete | Verification succeeds |
| **Failure mode** | Source missing → note it | Cannot determine → state confidence | No issues → clean bill | Empty workspace → empty inventory | No items → state clearly |

These differences are **procedural**, not just numeric. A `report` and a `diagnosis` on the same codebase should produce different operation sequences and different output structures because the procedures tell the agent to reason differently.

---

## 4. What Gets Removed

The following shallow elements are removed from all profiles:

- `allowedOperations` — never referenced by runtime.
- `retryGuidance` — never referenced by runtime.
- `expectedPhasePattern` — replaced by the structured procedure.
- `finalArtifactRequired` — redundant with procedure completion criteria.

The following fields are preserved and simplified:

- `name`, `description`
- `executionStepLimit`, `modelRequestLimit`
- `maxWorkspaceOperations`
- `maxListDirectory`, `maxReadFile`
- `procedure` — **new field** containing the structured phase instructions

---

## 5. Detection System

`detectWorkloadProfile(objective)` is **preserved exactly as-is**. No regex changes. No new keywords. The existing detection order and patterns remain.

The question this tranche answers is: **given the same detection system, do the profiles produce meaningfully different outcomes when their guidance becomes procedural?**

---

## 6. Implementation Scope

### File: `server.js`

#### Change A: WORKLOAD_PROFILES Object (lines 96–162)

For each of the 5 profiles:
- Remove `allowedOperations`, `retryGuidance`, `expectedPhasePattern`, `finalArtifactRequired`.
- Add `procedure` field containing the structured multi-phase instructions (array of strings).
- Preserve `name`, `description`, `executionStepLimit`, `modelRequestLimit`, `maxWorkspaceOperations`, `maxListDirectory`, `maxReadFile`.

#### Change B: buildProfileGuidance Function (lines 7402–7460)

- Remove the generic per-profile advice blocks (lines 7419–7457).
- Replace with injection of `profile.procedure` array.
- Keep limit caps injection.

#### Change C: getProfileRuntimeLimits Function (lines 7386–7400)

- No changes. Continue reading numeric limit fields from profile object.

#### Change D: detectWorkloadProfile Function (lines 7355–7384)

- No changes. Preserve exact regex patterns and detection order.

---

## 7. Success Criteria

The tranche is considered successful if:

### Criterion 1: Behavioral Differentiation Is Observable
A blinded human reviewer can distinguish which profile was used for at least **4 of 5** representative tickets based on the agent's operation sequence and output structure. (This tests whether the procedures produce different behavior, not just different limits.)

### Criterion 2: Each Profile Produces Its Expected Output Structure
For each profile, at least **1 of 2** representative tickets produces an output that matches the profile's expected structure:
- `report`: Contains "Sources Inspected" section and answers stated key questions.
- `diagnosis`: Contains "Observed Failure, Root Cause, Evidence, Confidence" structure.
- `recommendation`: Contains "Prioritized Recommendations" with impact/effort ranking.
- `bulk-inventory`: Contains "Total counts" and "Structure summary" sections.
- `refactor`: Produces file system mutations with a verification step.

### Criterion 3: No Regression
The `refactor` profile maintains its current performance on restructure-type tickets. The tranche does not degrade the only profile that currently works well.

### Criterion 4: Implementation Size Is Minimal
Only the profile definition object and the guidance builder function in `server.js` are modified. No new files. No runtime architecture changes. Total added lines < 150.

---

## 8. What This Tranche Does NOT Answer

This tranche does not test:
- Whether 5 profiles is the right number (consolidation remains an open question).
- Whether the detection system is adequate (regex keywords are preserved).
- Whether users need user-facing work definitions (no UI changes).
- Whether dynamic reclassification or feedback loops help (profiles remain static).

It answers one question only: **Do the existing 5 profiles contain meaningful behavioral distinctions when their guidance is procedural rather than superficial?**
