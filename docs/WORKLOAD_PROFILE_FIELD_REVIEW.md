# Workload Profile Field Review

## Method

Analyzed every field in the `WORKLOAD_PROFILES` object against the runtime code that reads it. For each field, determined:
1. Is it actively used by runtime code?
2. Does it materially influence agent behavior?
3. Is it necessary for testing procedure-driven adaptive execution?

Assumptions: No users, no backward compatibility, no migration concerns.

---

## Field-by-Field Determination

### Field: `name`

**Definition:** The profile identifier string.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7397): Copies `profile.name` into returned limits object as `profileName`.
- `buildProfileGuidance` (line 7410): Injects `profile.name` into the prompt: `"This ticket matches the '${profile.name}' workload profile..."`
- `detectWorkloadProfile` returns the string name, which is used to look up the profile in `WORKLOAD_PROFILES`.

**Materially influences behavior?** **Yes.** The name is how the profile is identified, looked up, and referenced in guidance. It is also exposed in the runtime envelope (`workloadProfile`, line 5946).

**Necessary for adaptive execution hypothesis?** **Yes.** The procedure must be associated with a named profile. The name is the lookup key.

**Verdict: KEEP**

---

### Field: `description`

**Definition:** A short human-readable description of the profile.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7398): Copies `profile.description` into returned limits object as `profileDescription`.
- `buildProfileGuidance` (line 7410): Injects `profile.description` into the prompt: `"...${profile.description}."`

**Materially influences behavior?** **Marginal.** The description provides context to the agent about what kind of work it is doing. It does not enforce anything, but it helps the agent understand the task category.

**Necessary for adaptive execution hypothesis?** **Yes.** The description helps the agent contextualize the procedure. It is a lightweight signal that complements the structured procedure.

**Verdict: KEEP**

---

### Field: `executionStepLimit`

**Definition:** Maximum execution steps allowed for this profile.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7392): `Math.min(baseLimits.maxExecutionSteps, profile.executionStepLimit)`
- The returned `limits.maxExecutionSteps` is enforced at line 4405: `if (currentStep >= limits.maxExecutionSteps)`

**Materially influences behavior?** **Yes.** A run that exceeds this limit is terminated with `RUN_LIMIT_EXCEEDED`. This is a hard runtime constraint.

**Necessary for adaptive execution hypothesis?** **Yes.** Different work types need different step budgets. A bulk inventory needs more steps than a simple diagnosis. This is a core adaptive parameter.

**Verdict: KEEP**

---

### Field: `modelRequestLimit`

**Definition:** Maximum model API requests allowed for this profile.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7393): `Math.min(baseLimits.maxModelRequestsPerRun, profile.modelRequestLimit)`
- The returned `limits.maxModelRequestsPerRun` is enforced at line 4396: `if (currentCount >= limits.maxModelRequestsPerRun)`

**Materially influences behavior?** **Yes.** A run that exceeds this limit is terminated. This controls how many times the agent can reason before completing.

**Necessary for adaptive execution hypothesis?** **Yes.** Different work types need different reasoning budgets. This is a core adaptive parameter.

**Verdict: KEEP**

---

### Field: `maxWorkspaceOperations`

**Definition:** Maximum total workspace operations allowed for this profile.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7394): `Math.min(baseLimits.maxWorkspaceOperationsPerRun, profile.maxWorkspaceOperations)`
- The returned `limits.maxWorkspaceOperationsPerRun` is enforced at line 4416: `if (nextCount > limits.maxWorkspaceOperationsPerRun)`

**Materially influences behavior?** **Yes.** This is a hard cap on total file operations.

**Necessary for adaptive execution hypothesis?** **Unsure.** While actively used, the variation between profiles is small (24 vs 32 for most profiles; 40 for bulk-inventory). There is no evidence that these specific values produce different outcomes. The more meaningful limit is the per-operation-type cap (`maxListDirectory`, `maxReadFile`). However, this field is a safety net and may be necessary to prevent runaway agents. 

**Verdict: KEEP (but standardize values)**

---

### Field: `maxListDirectory`

**Definition:** Maximum `listDirectory` operations allowed for this profile.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7395): Sets `maxListDirectoryPerRun` directly.
- `buildProfileGuidance` (line 7411): Injects into prompt: `"Use at most ${profile.maxListDirectory} listDirectory calls total."`
- Enforced in execution loop (lines 8837–8844): Throws `RUN_LIMIT_EXCEEDED` if exceeded.

**Materially influences behavior?** **Yes.** This is the most behaviorally significant limit. It directly constrains how much of the workspace structure the agent can explore. A diagnosis (2) vs. a bulk inventory (8) genuinely differ in their discovery needs.

**Necessary for adaptive execution hypothesis?** **Yes.** This is a core adaptive parameter that shapes agent behavior.

**Verdict: KEEP**

---

### Field: `maxReadFile`

**Definition:** Maximum `readFile` operations allowed for this profile.

**Actively used?** **Yes.**
- `getProfileRuntimeLimits` (line 7396): Sets `maxReadFilePerRun` directly.
- `buildProfileGuidance` (line 7411): Injects into prompt: `"Use at most ${profile.maxReadFile} readFile calls total."`
- Enforced in execution loop (lines 8846–8853): Throws `RUN_LIMIT_EXCEEDED` if exceeded.

**Materially influences behavior?** **Yes.** This constrains how many files the agent can inspect. A report (8) vs. a refactor (4) genuinely differ in their inspection depth.

**Necessary for adaptive execution hypothesis?** **Yes.** This is a core adaptive parameter.

**Verdict: KEEP**

---

### Field: `allowedOperations`

**Definition:** Array of operations permitted for this profile.

**Actively used?** **No.**
- This field exists in all 5 profile definitions (lines 105, 118, 131, 144, 157).
- **No runtime code ever reads `WORKLOAD_PROFILES[profileName].allowedOperations`.**
- The runtime uses `AGENT_DIRECT_OPERATIONS` (line 43) and `AGENT_ALLOWED_OPERATIONS` (line 36) for authorization.
- The only other `allowedOperations` references in the codebase are for workflow primitive contracts and runtime envelope construction — none reference the profile field.

**Materially influences behavior?** **No.** Dead field.

**Necessary for adaptive execution hypothesis?** **No.**

**Verdict: REMOVE**

---

### Field: `finalArtifactRequired`

**Definition:** Boolean indicating whether the profile requires a writeFile artifact.

**Actively used?** **Yes, superficially.**
- `buildProfileGuidance` (line 7415): Conditionally injects one sentence: `"The final response must produce the requested artifact via writeFile."`
- Not enforced by runtime. The agent may complete without producing an artifact regardless of this flag.

**Materially influences behavior?** **Minimal.** One sentence of prompt advice. In the procedure-driven model, artifact requirements are specified by the procedure itself (e.g., "Phase 5 — WRITE: Produce the report via writeFile").

**Necessary for adaptive execution hypothesis?** **No.** Redundant with procedure completion criteria.

**Verdict: REMOVE**

---

### Field: `expectedPhasePattern`

**Definition:** A human-readable string describing the expected phase progression.

**Actively used?** **Yes, superficially.**
- `buildProfileGuidance` (line 7412): Injects into prompt: `"Expected phase pattern: ${profile.expectedPhasePattern}."`
- **Not enforced by the phase state machine.** The actual phase transitions are controlled by `ALLOWED_PHASE_TRANSITIONS` (lines 84–90), which is global and profile-agnostic.

**Materially influences behavior?** **Minimal.** Advisory text only. The agent sees it but the runtime does not enforce it. In the procedure-driven model, the phase sequence is specified by the procedure itself.

**Necessary for adaptive execution hypothesis?** **No.** Redundant with procedure.

**Verdict: REMOVE**

---

### Field: `retryGuidance`

**Definition:** A string providing guidance on retry behavior.

**Actively used?** **No.**
- This field exists in all 5 profile definitions (lines 108, 121, 134, 147, 160).
- **No runtime code ever reads `WORKLOAD_PROFILES[profileName].retryGuidance`.**

**Materially influences behavior?** **No.** Dead field.

**Necessary for adaptive execution hypothesis?** **No.**

**Verdict: REMOVE**

---

## Summary Table

| Field | Actively Used? | Material Influence? | Necessary for Hypothesis? | Verdict |
|---|---|---|---|---|
| `name` | Yes | Yes | Yes | **KEEP** |
| `description` | Yes | Marginal | Yes | **KEEP** |
| `executionStepLimit` | Yes | Yes | Yes | **KEEP** |
| `modelRequestLimit` | Yes | Yes | Yes | **KEEP** |
| `maxWorkspaceOperations` | Yes | Yes | Unsure | **KEEP (standardize)** |
| `maxListDirectory` | Yes | Yes | Yes | **KEEP** |
| `maxReadFile` | Yes | Yes | Yes | **KEEP** |
| `allowedOperations` | **No** | No | No | **REMOVE** |
| `finalArtifactRequired` | Yes (superficial) | Minimal | No | **REMOVE** |
| `expectedPhasePattern` | Yes (superficial) | Minimal | No | **REMOVE** |
| `retryGuidance` | **No** | No | No | **REMOVE** |

---

## Reduced Profile Object

After removal, the smallest profile object required to test procedure-driven adaptive execution:

```javascript
const WORKLOAD_PROFILES = {
  report: {
    name: 'report',
    description: 'Inspection-heavy task producing a summary or analysis document',
    executionStepLimit: 12,
    modelRequestLimit: 8,
    maxWorkspaceOperations: 32,
    maxListDirectory: 3,
    maxReadFile: 8,
    procedure: [
      'Phase 1 — PLAN: State what the report must cover...',
      'Phase 2 — DISCOVER: Use listDirectory...',
      // ... etc
    ]
  },
  // ... other profiles
};
```

**Fields removed:** `allowedOperations`, `finalArtifactRequired`, `expectedPhasePattern`, `retryGuidance`

**Fields kept:** `name`, `description`, `executionStepLimit`, `modelRequestLimit`, `maxWorkspaceOperations`, `maxListDirectory`, `maxReadFile`

**Fields added:** `procedure` (the structured multi-phase instructions that replace superficial guidance)

---

## Observations

1. **4 of 11 fields are dead or superficial.** `allowedOperations` and `retryGuidance` are completely unused. `finalArtifactRequired` and `expectedPhasePattern` are used only to inject one sentence of advisory text each.

2. **The core adaptive mechanism is numeric limits + prompt guidance.** Only `maxListDirectory`, `maxReadFile`, and the guidance text (which is being replaced by `procedure`) have demonstrated behavioral influence. The step/request/operation limits are safety nets.

3. **The profile object is currently 50% decorative.** Removing dead and superficial fields reduces the object to its functional core.

4. **The new `procedure` field is the only addition.** It replaces the superficial guidance with structured behavioral instructions. This is the entire hypothesis being tested.
