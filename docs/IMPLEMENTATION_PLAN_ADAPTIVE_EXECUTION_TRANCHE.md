# Implementation Plan: Adaptive Execution Tranche

## Overview

Implement the first adaptive execution tranche: replace shallow profile guidance with structured procedures, remove dead fields, and preserve all 5 existing profiles and runtime architecture.

---

## 1. Exact Files to Modify

### Primary File

| File | Lines Modified | Nature of Change |
|---|---|---|
| `server.js` | ~100 lines | Profile object reduced, guidance function simplified, procedure arrays added |

### Test Files (Update Required)

| File | Tests Broken | Reason |
|---|---|---|
| `scripts/workload-profile-test.js` | `testProfileGuidance`, `testRefactorAllowsRename` | Guidance text changes; `allowedOperations` removed |
| `scripts/organization-guidance-test.js` | All 10 tests | `buildProfileGuidance` function body changes completely |
| `scripts/report-generation-test.js` | `testReportSystemPrompt` (minor) | `buildProfileGuidance` still exists but guidance text changes |

---

## 2. Exact Functions to Modify

### Function A: `WORKLOAD_PROFILES` Constant Object

**Location:** `server.js`, lines 96–162

**Current structure:** 5 profiles × 11 fields each = 55 fields, 4 dead, 1 superficial, 6 functional.

**Changes:**
- **Remove fields:** `allowedOperations`, `retryGuidance`, `expectedPhasePattern`, `finalArtifactRequired` (4 fields × 5 profiles = 20 lines removed).
- **Add field:** `procedure` (array of strings, structured multi-phase instructions).
- **Preserve fields:** `name`, `description`, `executionStepLimit`, `modelRequestLimit`, `maxWorkspaceOperations`, `maxListDirectory`, `maxReadFile`.

**Estimated impact:** ~70 lines net (remove 20 lines of dead fields, add ~40–50 lines of procedure arrays).

---

### Function B: `buildProfileGuidance(objective)`

**Location:** `server.js`, lines 7402–7460 (58 lines)

**Current behavior:**
1. Detects profile.
2. Injects profile name, description, and limits.
3. Injects `expectedPhasePattern`.
4. Conditionally injects `finalArtifactRequired` sentence.
5. Per-profile generic advice blocks (lines 7419–7457):
   - `report`: 2 sentences about citing paths and one artifact.
   - `diagnosis`: 2 sentences about root cause and evidence.
   - `refactor`: 8 lines of structured 4-phase procedure.
   - `recommendation`: 2 sentences about prioritization and linking evidence.
   - `bulk-inventory`: 2 sentences about grouping and one summary file.

**Target behavior:**
1. Detects profile.
2. Injects profile name, description, and limits (same as current).
3. Injects `profile.procedure` array (replaces all generic advice and refactor procedure).
4. No per-profile branching. No conditional logic. Single path.

**Changes:**
- Remove `expectedPhasePattern` injection (line 7412).
- Remove `finalArtifactRequired` conditional block (lines 7415–7417).
- Remove all per-profile `if` blocks (lines 7419–7457).
- Add `if (profile.procedure) { lines.push(...profile.procedure); }`.

**Estimated impact:** ~15 lines (remove ~40 lines, add ~3 lines).

---

### Function C: `getProfileRuntimeLimits(baseLimits, profileName)`

**Location:** `server.js`, lines 7386–7400

**Changes:** **None required.** This function already reads only the fields being preserved (`executionStepLimit`, `modelRequestLimit`, `maxWorkspaceOperations`, `maxListDirectory`, `maxReadFile`). It does not reference any dead fields.

---

### Function D: `detectWorkloadProfile(objective)`

**Location:** `server.js`, lines 7355–7384

**Changes:** **None required.** Preserve exact regex patterns and detection order. The procedure-driven hypothesis tests whether the existing taxonomy is meaningful, not whether detection is adequate.

---

### Function E: `buildAgentPrompt` (indirect)

**Location:** `server.js`, line 8381 (and surrounding context)

**Current call:**
```javascript
...buildProfileGuidance(ticket.objective),
```

**Changes:** **None required.** The function signature and return type of `buildProfileGuidance` remain the same (array of strings). All callers continue to work.

---

## 3. Estimated Line Count

| Component | Lines Removed | Lines Added | Net Change |
|---|---|---|---|
| `WORKLOAD_PROFILES` dead fields | ~20 | 0 | −20 |
| `WORKLOAD_PROFILES` procedure arrays | 0 | ~50 | +50 |
| `buildProfileGuidance` simplification | ~40 | ~5 | −35 |
| **Total in `server.js`** | **~60** | **~55** | **~−5** (net reduction) |
| Test file updates | ~30 | ~20 | −10 |
| **Grand total** | **~90** | **~75** | **~−15** |

**Net result:** The codebase shrinks slightly. The profile object becomes smaller (removing dead fields). The guidance function becomes dramatically smaller (removing per-profile branching). The procedures add bulk but replace more lines than they consume.

---

## 4. Risks

### Risk 1: Tests Break (High Probability, Low Impact)

**Description:** `workload-profile-test.js` and `organization-guidance-test.js` assert specific strings in `buildProfileGuidance` output and `WORKLOAD_PROFILES` constant. These tests will fail after the change.

**Mitigation:** Update tests as part of this tranche. Tests should verify:
- `buildProfileGuidance` returns non-empty arrays for each profile.
- Guidance contains the profile name and description.
- Guidance contains limit instructions.
- Guidance contains procedure text (contains "Phase" or equivalent structured markers).
- `getProfileRuntimeLimits` still returns correct numeric limits.
- `detectWorkloadProfile` still detects the same keywords.

**Severity:** Low. Test failures are expected and easily fixed. No runtime behavior is broken.

---

### Risk 2: Procedure Text Length Increases Token Budget

**Description:** Each procedure is ~8–12 lines. The current guidance is ~5–10 lines. The net increase per prompt is modest (~2–4 lines), but for long procedures (e.g., refactor's 8 lines become a formal procedure array), the token count may increase.

**Mitigation:** Monitor prompt length. If procedures push token budgets near limits, compress wording. The refactor procedure is already long in the current code; the tranche formalizes it but does not dramatically expand it.

**Severity:** Low. The existing refactor procedure is already ~10 lines. Other profiles gain structured procedures but lose generic advice, balancing the increase.

---

### Risk 3: Agent Ignores Procedures

**Description:** The agent may not follow structured procedures even when instructed. This is a hypothesis risk, not an implementation risk. The tranche is specifically designed to test whether procedures change behavior.

**Mitigation:** Not mitigated. This is the experiment. If the agent ignores procedures, the adaptive execution hypothesis is invalidated. That is a valid and useful outcome.

**Severity:** Medium. This is the core risk of the hypothesis, not the implementation.

---

### Risk 4: Legacy Report Detection Interference

**Description:** The fallback `isReportObjective` / `getReportRuntimeLimits` (lines 4319–4322, 7338–7351) may apply to objectives that do not match any profile. This is a backward-compatibility path for pre-profile code.

**Mitigation:** Preserve the fallback exactly as-is. It does not conflict with the tranche. The fallback only activates when `detectWorkloadProfile` returns `null`.

**Severity:** Low. No change to fallback path.

---

### Risk 5: `allowedOperations` Was Referenced Elsewhere

**Description:** The `allowedOperations` field is referenced in `scripts/agent-regression-test.js` and `scripts/allocated-regression-test.js` but only in the context of **workflow primitive contracts and replay snapshots**, not workload profiles. No code references `WORKLOAD_PROFILES[profile].allowedOperations`.

**Mitigation:** Confirmed by grep: `allowedOperations` appears in `server.js` lines 1869, 4229, 4702 (workflow primitive contracts), 5941 (runtime envelope), and 8323 (base allowed ops fallback). None reference the profile field.

**Severity:** Very low. Already confirmed unused.

---

### Risk 6: Envelope Size Increase

**Description:** The `procedure` field is not added to the runtime envelope, so no change there. However, the guidance array (which includes procedure text) is injected into the system prompt. The prompt length increase is the same as Risk 2.

**Mitigation:** Same as Risk 2.

**Severity:** Low.

---

## 5. Rollback Plan

### Step 1: Pre-Implementation Checkpoint

Before modifying code:
1. Run existing tests: `npm run test:workflow` and `node scripts/workload-profile-test.js` and `node scripts/organization-guidance-test.js`.
2. Verify all tests pass.
3. Save current `server.js` to `server.js.backup.pre-procedure`.

### Step 2: Implementation Order

1. **Modify `WORKLOAD_PROFILES`** first (lines 96–162).
   - Remove dead fields.
   - Add `procedure` arrays.
   - Run `node scripts/workload-profile-test.js` — expect `testRefactorAllowsRename` to fail (removing `allowedOperations`).
2. **Modify `buildProfileGuidance`** second (lines 7402–7460).
   - Simplify to single-path injection.
   - Run `node scripts/workload-profile-test.js` and `node scripts/organization-guidance-test.js` — expect all guidance-related tests to fail.
3. **Update test files** to match new guidance output.
   - `scripts/workload-profile-test.js`: Update `testProfileGuidance` assertions. Update `testRefactorAllowsRename` to not check `allowedOperations`.
   - `scripts/organization-guidance-test.js`: Update all tests to assert procedure content instead of inline guidance text.
4. **Run full verification:**
   - `npm run build` (syntax check)
   - `npm run test:workflow`
   - `npm run test:postcondition`
   - `node scripts/workload-profile-test.js`
   - `node scripts/organization-guidance-test.js`
   - `node scripts/report-generation-test.js`

### Step 3: Rollback Procedure

If any of the following occurs:
- Runtime errors in `server.js` (syntax, undefined references, crashes)
- `npm run build` fails
- Core functionality tests fail (`npm run test:workflow`, `npm run test:postcondition`)
- The change is deemed unsuitable before evaluation

**Rollback steps:**
1. Restore `server.js` from `server.js.backup.pre-procedure`.
2. Revert test files from git or restore from backup.
3. Verify: `npm run build` passes.
4. Verify: `npm run test:workflow` passes.

**Estimated rollback time:** < 2 minutes (single file restore + verification).

---

## 6. Definition of Done

The tranche is implemented when:

1. `server.js` contains 5 profiles with `procedure` arrays and no dead fields.
2. `buildProfileGuidance` injects procedures without per-profile branching.
3. `getProfileRuntimeLimits` and `detectWorkloadProfile` are unchanged.
4. All existing tests pass after updating assertions.
5. `npm run build` passes.
6. `npm run test:workflow` passes.
7. `npm run test:postcondition` passes.

The tranche is **not** evaluated until the evaluation plan (`EVALUATION_PLAN_ADAPTIVE_EXECUTION.md`) is executed. Implementation and evaluation are separate phases.
