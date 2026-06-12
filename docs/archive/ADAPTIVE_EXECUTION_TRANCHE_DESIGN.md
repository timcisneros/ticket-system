# Adaptive Execution: Smallest Meaningful Implementation Tranche

## Goals

1. Produce materially different agent behavior for distinct work types, not just numeric cap variations.
2. Cover the highest-leverage unrepresented work patterns from the 100-scenario corpus.
3. Remove superficial elements from the current profile system that create the illusion of adaptation without changing behavior.
4. Keep the implementation small enough to be evaluated against the existing evaluation plan.

---

## Current State Summary

The existing system has **5 profiles** (`report`, `diagnosis`, `refactor`, `recommendation`, `bulk-inventory`) with the following characteristics:

- **Detection:** Regex keyword matching on the objective string.
- **Behavioral changes:**
  - Numeric limits on `listDirectory` and `readFile` (varies by 2–6 calls).
  - Generic 2–3 sentence prompt guidance per profile.
  - `refactor` is the only profile with a structured multi-phase procedure.
- **Superficial elements:**
  - `diagnosis`, `recommendation`, and `bulk-inventory` differ from `report` only by read limits and 2 sentences of advice.
  - `allowedOperations` field exists in profile definitions but is **never referenced by runtime code**.
  - `retryGuidance` field exists but is **never referenced by runtime code**.
  - `expectedPhasePattern` is advisory text; the actual phase state machine is hardcoded and profile-agnostic.
  - `finalArtifactRequired` removes one sentence from guidance; the runtime does not enforce it.
  - `maxWorkspaceOperations` varies by 8 (24 vs 32) across profiles with no observed behavioral impact.

---

## Scope

### 1. Profile Consolidation: 5 → 3 Profiles

Merge `report`, `diagnosis`, `recommendation`, and `bulk-inventory` into a single **`analysis`** profile. These are all inspection-heavy synthesis tasks with identical operation needs and overlapping guidance. Rename `refactor` to **`restructure`** (clearer scope). Add one new profile: **`planning`**.

| New Profile | Merged From / Source | Covers Corpus Patterns |
|---|---|---|
| `analysis` | `report` + `diagnosis` + `recommendation` + `bulk-inventory` | Document analysis (21), Diagnosis (2), Recommendations (2), Inventory/catalog (1) |
| `restructure` | `refactor` (renamed) | Restructure/reorganize (~3) |
| `planning` | **New** | Planning and scoping (16), Policy drafting (9) |

### 2. Structured Behavioral Procedures

Replace the generic guidance for `analysis` and `planning` with **structured multi-phase procedures** modeled on `restructure` (the only existing profile with genuine behavioral orchestration).

Each procedure must specify:
- **Phase sequence:** The exact order of reasoning steps.
- **Per-phase operation constraints:** Which operations are appropriate in each phase.
- **Completion criteria:** What must be true before the agent may declare completion.
- **Failure mode:** What to do if required information is missing or ambiguous.

This replaces the current pattern of "limits + vague advice" with "procedure + limits."

### 3. Remove Superficial Fields

Remove from `WORKLOAD_PROFILES` object definitions:
- `allowedOperations` — unused by runtime.
- `retryGuidance` — unused by runtime.
- `expectedPhasePattern` — advisory only, not enforced; replaced by structured procedure.
- `finalArtifactRequired` — redundant with procedure completion criteria.

Keep and simplify:
- `name`, `description` — for envelope and detection.
- `executionStepLimit`, `modelRequestLimit` — standardize to 12/8 for `analysis` and `planning`; keep 16/10 for `restructure` (path mutations need more steps).
- `maxWorkspaceOperations` — standardize to 32 for `analysis` and `planning`; keep 40 for `restructure` (batch operations).
- `maxListDirectory`, `maxReadFile` — keep as the primary behaviorally meaningful limit variation.
- `procedure` — new field containing the structured phase instructions (array of strings, like `restructure` currently has).

### 4. Detection Update

Update `detectWorkloadProfile(objective)` to map to 3 profiles:

| Profile | Detection Regex (first match wins) |
|---|---|
| `restructure` | `\b(move\|rename\|restructur\|refactor\|reorganize\|archive\|consolidate)\b` |
| `planning` | `\b(scope\|plan\|draft\|policy\|procedure\|roadmap\|strategy\|initiative\|framework)\b` |
| `analysis` | `\b(report\|summary\|synthesis\|overview\|analysis\|status\|audit\|diagnos\|recommend\|top [0-9]+\|inventory\|catalog\|investigate\|assess\|review\|evaluate)\b` |

The `analysis` regex is last (catch-all for inspection-heavy tasks).

### 5. Prompt Injection Update

Update `buildProfileGuidance(objective)` to:
1. Inject the profile name and description.
2. Inject the limit caps (`maxListDirectory`, `maxReadFile`).
3. Inject the **structured procedure** (the multi-phase instructions).
4. Do not inject generic advice sentences.

The `restructure` profile keeps its existing 4-phase procedure (DISCOVER → MUTATE → VERIFY → COMPLETE). The `analysis` and `planning` profiles gain new procedures.

---

## Non-Goals

1. **Do not change runtime architecture.** The phase state machine (`EXECUTION_PHASES`, `ALLOWED_PHASE_TRANSITIONS`, `PHASE_OPERATIONS`) remains hardcoded and global. The procedure is injected as prompt text; it is not machine-enforced beyond the existing phase transitions.
2. **Do not add user-facing configuration.** No UI for creating profiles. No user-authored work definitions. No playbook system.
3. **Do not change ticket or workflow abstractions.** Tickets remain free-text objectives. Workflows remain static action graphs.
4. **Do not change agent operation authorization.** `AGENT_DIRECT_OPERATIONS` and `AGENT_MUTATING_OPERATIONS` remain unchanged.
5. **Do not add model selection or temperature adaptation.** All profiles use the same agent model with the same parameters.
6. **Do not implement feedback loops or dynamic reclassification.** Profiles are static for the entire run.
7. **Do not add new operations.** The agent can still only `listDirectory`, `readFile`, `writeFile`, `createFolder`, `renamePath`, `deletePath`.

---

## Tranche Definition

### File: `server.js`

#### Change A: WORKLOAD_PROFILES Object (lines 96–162)

**Remove:** `diagnosis`, `recommendation`, `bulk-inventory` profiles.

**Rename:** `refactor` → `restructure`.

**Modify:** `report` → `analysis` with expanded description and new `procedure` field.

**Add:** `planning` profile with `procedure` field.

**Remove fields:** `allowedOperations`, `retryGuidance`, `expectedPhasePattern`, `finalArtifactRequired` from all profile objects.

**Add field:** `procedure` (array of strings, injected into prompt like `restructure` currently does).

**Standardize limits:**
- `analysis` and `planning`: 12 steps, 8 requests, 32 operations.
- `restructure`: 16 steps, 10 requests, 40 operations.

**Keep varying:** `maxListDirectory` and `maxReadFile` (the only limits with observed behavioral impact).

#### Change B: detectWorkloadProfile Function (lines 7355–7384)

**Update regex order and mappings:**
1. `restructure` (first, same regex as current refactor).
2. `planning` (new regex for scope/plan/draft/policy).
3. `analysis` (last, catch-all with expanded regex covering old report + diagnosis + recommendation + bulk-inventory keywords).

#### Change C: buildProfileGuidance Function (lines 7402–7460)

**Remove:** profile-specific generic advice blocks (the 2–3 sentence per-profile advice currently lines 7419–7457).

**Replace with:** injection of `profile.procedure` array. The procedure is the structured multi-phase instructions.

**Keep:** limit caps injection (lines 7410–7412 equivalent).

**Keep:** `restructure` procedure as-is (it already uses this pattern).

#### Change D: getProfileRuntimeLimits Function (lines 7386–7400)

**No changes required.** It already reads the numeric limit fields from the profile object. Standardizing the values is a data change, not a code change.

---

## Expected Behavioral Differences

### Before (Current)

| Ticket | Detected Profile | Agent Receives |
|---|---|---|
| "Audit GDPR compliance" | `report` | "You are a report. Use at most 3 listDirectory. Cite file paths. One artifact." |
| "Diagnose inventory 503 errors" | `diagnosis` | "You are a diagnosis. Use at most 2 listDirectory. Focus on root cause." |
| "Scope CRM replacement" | `null` | Default limits, no guidance. |
| "Move old files to archive" | `refactor` | 4-phase structured procedure. |

**Result:** `report` and `diagnosis` produce nearly identical behavior. The agent reads files and writes an artifact. The guidance does not change the approach.

### After (Tranche)

| Ticket | Detected Profile | Agent Receives |
|---|---|---|
| "Audit GDPR compliance" | `analysis` | Structured procedure: PLAN → INSPECT → SYNTHESIZE → WRITE → VERIFY. Specific completion criteria. |
| "Diagnose inventory 503 errors" | `analysis` | Same structured `analysis` procedure. The work type is handled by the procedure, not by a separate profile. |
| "Scope CRM replacement" | `planning` | Structured procedure: RESEARCH → SYNTHESIZE → DRAFT → VALIDATE. Specific completion criteria. |
| "Move old files to archive" | `restructure` | Same 4-phase procedure as before. |

**Result:** `analysis` and `planning` now have distinct, structured procedures. The agent is told HOW to approach the work, not just WHAT the limits are.

---

## Success Criteria

The tranche is considered successful if, when evaluated against the existing evaluation plan (`EVALUATION_PLAN_ADAPTIVE_EXECUTION.md`), it produces the following:

### Criterion 1: Behavioral Differentiation Is Observable

A human reviewer, blinded to condition, can correctly identify which profile was used for at least **4 of 6** runs (3 profiles × 2 representative tickets each) based solely on the agent's phase progression and output structure.

### Criterion 2: Planning Work Is Now Covered

Tickets matching the `planning` profile (e.g., "Scope CRM replacement") achieve **higher Objective Coverage scores** than the same tickets run with no profile (the control baseline in the evaluation plan).

### Criterion 3: Analysis Work Is More Consistent

The merged `analysis` profile produces **less variance in Output Quality scores** across different analysis-type tickets than the current separate `report`/`diagnosis`/`recommendation` profiles. The procedure reduces agent inconsistency.

### Criterion 4: No Regression on Restructure

The `restructure` profile (formerly `refactor`) maintains its current performance on restructure-type tickets. The tranche does not degrade the only existing profile with genuine behavioral differentiation.

### Criterion 5: Implementation Size Is Minimal

The implementation touches **only** the profile definition object, the detection function, and the guidance builder function in `server.js`. No new files. No runtime architecture changes. Total added lines < 100.

---

## Why This Is the Minimum Meaningful Tranche

| Element | Current State | Tranche State | Why It Matters |
|---|---|---|---|
| Profile count | 5 | 3 | Removes redundancy without losing coverage. |
| Profiles with procedures | 1 (`refactor`) | 3 (`analysis`, `restructure`, `planning`) | Procedures are the only mechanism that has demonstrated genuine behavioral differentiation. |
| Corpus coverage | ~10–12% | ~55–60% | `analysis` covers 26 scenarios; `planning` covers 25; `restructure` covers ~3. |
| Superficial fields | 4 unused/ineffective | 0 | Reduces complexity and clarifies what actually changes behavior. |
| Code files changed | N/A | 1 (`server.js`) | No architectural changes, no new dependencies, no runtime risk. |
| Lines of code added | N/A | < 100 | Small enough to review, test, and revert in one session. |

This tranche does not solve all problems. It does not make phase enforcement profile-specific. It does not add dynamic adaptation. It does not cover the full 100-scenario corpus. But it **does** make adaptive execution real for the majority of work patterns the product encounters, and it **does** remove the superficial elements that create false confidence. It is the smallest change that is worthy of a real evaluation.
