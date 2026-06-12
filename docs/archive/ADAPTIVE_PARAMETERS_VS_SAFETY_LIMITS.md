# Adaptive Parameters vs Safety Limits

## Method

Analyzed `executionStepLimit`, `modelRequestLimit`, and `maxWorkspaceOperations` against:
1. How the base limit is computed (default values vs env overrides)
2. How the profile limit is applied (`Math.min` logic)
3. Which limits are exposed to the agent (runtime envelope and prompt guidance)
4. Whether the agent can use the limit to shape its strategy

No assumptions about future usefulness. Only current runtime evidence.

---

## Evidence: How Limits Are Computed

### Base Limits (Default Configuration)

```javascript
const DEFAULT_AGENT_RUNTIME_LIMITS = {
  maxExecutionSteps: 4,
  maxWorkspaceOperationsPerRun: 32,
  maxModelRequestsPerRun: 4,
  maxRuntimeDurationMs: 120000
};
```

Base limits are read from env variables with these defaults:
- `AGENT_MAX_EXECUTION_STEPS` → 4
- `AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN` → 32
- `AGENT_MAX_MODEL_REQUESTS_PER_RUN` → 4

### Profile Limit Application

```javascript
function getProfileRuntimeLimits(baseLimits, profileName) {
  const profile = WORKLOAD_PROFILES[profileName];
  if (!profile) return baseLimits;

  return {
    ...baseLimits,
    maxExecutionSteps: Math.min(baseLimits.maxExecutionSteps, profile.executionStepLimit),
    maxModelRequestsPerRun: Math.min(baseLimits.maxModelRequestsPerRun, profile.modelRequestLimit),
    maxWorkspaceOperationsPerRun: Math.min(baseLimits.maxWorkspaceOperationsPerRun, profile.maxWorkspaceOperations),
    maxListDirectoryPerRun: profile.maxListDirectory,
    maxReadFilePerRun: profile.maxReadFile,
    // ...
  };
}
```

**Critical finding:** `Math.min(base, profile)` means the profile can only **reduce** the base limit, never **increase** it.

---

## Field 1: executionStepLimit

### Profile Values vs Base

| Profile | `executionStepLimit` | Default Base | Effective Limit |
|---|---|---|---|
| report | 12 | 4 | **4** (base wins) |
| diagnosis | 12 | 4 | **4** (base wins) |
| refactor | 12 | 4 | **4** (base wins) |
| recommendation | 12 | 4 | **4** (base wins) |
| bulk-inventory | 16 | 4 | **4** (base wins) |

**Evidence:** With default configuration, the profile value is **never applied** for any profile. The base limit of 4 overrides all profile values.

The profile limit only becomes effective if the env variable `AGENT_MAX_EXECUTION_STEPS` is set to a value **greater than the profile limit** (e.g., `AGENT_MAX_EXECUTION_STEPS=20` would yield `Math.min(20, 12) = 12`).

### Agent Awareness

**Exposed to agent?** **Yes.** The runtime envelope includes:
```javascript
maxExecutionSteps: limits.maxExecutionSteps,  // line 5945
currentStep: step,                              // line 5944
```

The agent knows both the maximum and current step count, so it can theoretically pace itself.

### Behavioral Impact

**Does it shape behavior?** **No.** With default configuration, the limit is 4 for all profiles, so there is **no variation** between work types. The agent gets the same step budget regardless of profile.

Even if the env is raised (e.g., to 20), the variation between profiles is small (12 vs 16), and the agent receives this as a raw numeric cap, not as a behavioral signal about how to approach the work.

### Classification

**Verdict: Safety limit.**

It prevents runaway execution loops. It does not adaptively shape agent strategy. With defaults, it is dead (base limit overrides all profiles). Even when active via env override, it is a crude global cap, not a work-type-specific behavioral parameter.

---

## Field 2: modelRequestLimit

### Profile Values vs Base

| Profile | `modelRequestLimit` | Default Base | Effective Limit |
|---|---|---|---|
| report | 8 | 4 | **4** (base wins) |
| diagnosis | 8 | 4 | **4** (base wins) |
| refactor | 8 | 4 | **4** (base wins) |
| recommendation | 8 | 4 | **4** (base wins) |
| bulk-inventory | 10 | 4 | **4** (base wins) |

**Evidence:** With default configuration, the profile value is **never applied** for any profile. The base limit of 4 overrides all profile values.

The profile limit only becomes effective if `AGENT_MAX_MODEL_REQUESTS_PER_RUN` is set to a value greater than the profile limit.

### Agent Awareness

**Exposed to agent?** **No.** The runtime envelope does NOT include `maxModelRequestsPerRun`:
```javascript
return {
  maxExecutionSteps: limits.maxExecutionSteps,  // present
  // maxModelRequestsPerRun is NOT in the envelope
};
```

The agent has no way to know this limit exists. It cannot plan around it.

### Behavioral Impact

**Does it shape behavior?** **No.** The agent is unaware of the limit. Even if aware, with defaults there is no variation between profiles (all capped at 4).

### Classification

**Verdict: Safety limit.**

It prevents runaway API call costs. It is invisible to the agent and does not shape strategy. With defaults, it is dead.

---

## Field 3: maxWorkspaceOperations

### Profile Values vs Base

| Profile | `maxWorkspaceOperations` | Default Base | Effective Limit |
|---|---|---|---|
| report | 32 | 32 | **32** (equal, no effect) |
| diagnosis | 24 | 32 | **24** (profile reduces by 8) |
| refactor | 24 | 32 | **24** (profile reduces by 8) |
| recommendation | 24 | 32 | **24** (profile reduces by 8) |
| bulk-inventory | 40 | 32 | **32** (base wins) |

**Evidence:** With default configuration:
- **2 profiles** (report, bulk-inventory): Profile value is dead (equal to or higher than base).
- **3 profiles** (diagnosis, refactor, recommendation): Profile reduces limit by 8 (24 vs 32).
- **0 profiles** receive an increase.

### Agent Awareness

**Exposed to agent?** **No.** The runtime envelope does NOT include `maxWorkspaceOperationsPerRun`:
```javascript
return {
  maxExecutionSteps: limits.maxExecutionSteps,  // present
  // maxWorkspaceOperationsPerRun is NOT in the envelope
};
```

The agent does not know this limit exists. It cannot plan around it.

### Behavioral Impact

**Does it shape behavior?** **No.** The agent is unaware of the limit. Even if aware, the variation is minimal (24 vs 32) and only applies to 3 of 5 profiles. The agent does not receive a signal like "you are doing diagnosis, so use fewer operations." It simply gets terminated if it exceeds the invisible cap.

### Classification

**Verdict: Safety limit.**

It prevents runaway file system operations. It is invisible to the agent and does not shape strategy. For 2 of 5 profiles, it is dead with defaults. For the other 3, it marginally tightens the safety net.

---

## Comparative Analysis: What Makes a Field Adaptive?

For comparison, here is how `maxListDirectory` behaves:

| Profile | `maxListDirectory` | Base | Effective | In Prompt? | In Envelope? | Variation |
|---|---|---|---|---|---|---|
| report | 3 | N/A | 3 | **Yes** | Yes | Profile-specific |
| diagnosis | 2 | N/A | 2 | **Yes** | Yes | Profile-specific |
| refactor | 2 | N/A | 2 | **Yes** | Yes | Profile-specific |
| recommendation | 2 | N/A | 2 | **Yes** | Yes | Profile-specific |
| bulk-inventory | 8 | N/A | 8 | **Yes** | Yes | Profile-specific |

**Why `maxListDirectory` is adaptive:**
1. **Directly told to the agent:** `"Use at most ${profile.maxListDirectory} listDirectory calls total."` (line 7411)
2. **Meaningfully varies by work type:** 2 (focused tasks) vs 8 (broad inventory)
3. **Shapes strategy:** The agent knows it must discover efficiently vs. exhaustively depending on the profile
4. **Enforced in real-time:** The execution loop throws if exceeded (lines 8837–8844)

**Why the three fields are NOT adaptive:**
1. **Either dead or marginally active:** With defaults, `executionStepLimit` and `modelRequestLimit` never apply. `maxWorkspaceOperations` only marginally tightens 3 profiles.
2. **Invisible or generic:** `modelRequestLimit` and `maxWorkspaceOperations` are not in the envelope. `maxExecutionSteps` is in the envelope but identical across all profiles with defaults.
3. **Do not shape strategy:** The agent cannot use these limits to decide how to approach the work. They are termination triggers, not behavioral signals.

---

## Summary Table

| Field | Type | Used by Runtime? | Agent Aware? | Varies by Profile? | Shapes Behavior? | Verdict |
|---|---|---|---|---|---|---|
| `executionStepLimit` | Numeric cap | Yes (but dead with defaults) | Yes (envelope) | No (all 4 with defaults) | No | **Safety limit** |
| `modelRequestLimit` | Numeric cap | Yes (but dead with defaults) | No (not in envelope) | No (all 4 with defaults) | No | **Safety limit** |
| `maxWorkspaceOperations` | Numeric cap | Yes (marginally active) | No (not in envelope) | Minimal (24 vs 32 for 3 profiles) | No | **Safety limit** |
| `maxListDirectory` | Numeric cap | Yes | Yes (prompt + envelope) | Yes (2 to 8) | Yes | **Adaptive parameter** |
| `maxReadFile` | Numeric cap | Yes | Yes (prompt + envelope) | Yes (4 to 8) | Yes | **Adaptive parameter** |

---

## Conclusion

**All three fields are safety limits, not adaptive parameters.**

- `executionStepLimit` and `modelRequestLimit` are **dead with default configuration** because the base limit (4) is lower than all profile values. They only activate if an env variable overrides the base above the profile threshold.
- `maxWorkspaceOperations` is **marginally active** for 3 of 5 profiles but invisible to the agent. It is a runtime kill switch, not a behavioral signal.
- None of the three fields tell the agent how to approach the work. They only terminate the agent if it does too much.

**The only adaptive parameters in the current system are `maxListDirectory` and `maxReadFile`.** They are explicitly communicated to the agent, they vary meaningfully by work type, and they directly shape discovery strategy.

**Recommendation:** Keep `executionStepLimit`, `modelRequestLimit`, and `maxWorkspaceOperations` as safety limits. Do not treat them as part of the adaptive execution hypothesis. They are runtime guardrails, not behavioral differentiators.
