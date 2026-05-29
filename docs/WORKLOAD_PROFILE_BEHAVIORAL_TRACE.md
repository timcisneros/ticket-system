# Workload Profile Behavioral Trace

## Method

This document traces a single agent-mode ticket through the system, documenting every decision point where the selected Workload Profile influences behavior. Evidence is drawn from `server.js` at the exact lines referenced.

---

## Stage 1: Ticket Creation

**Decision point:** None at creation. The ticket is created with a free-text `objective` and `executionMode: "agent"`. The Workload Profile is not selected by the user; it is inferred later.

**Evidence:**
- `views/index.ejs` lines 7-90: Ticket creation form captures only `objective`, `assignmentTargetType`, `assignmentTargetId`, `capabilityType` (directAction or workflow), and optional `workflowId`/`workflowInput`.
- There is no profile selector in the UI. The profile is invisible to the user.

**Runtime effects:** None. The profile does not exist at creation time.

**Prompt effects:** None.

**Execution effects:** None.

---

## Stage 2: Profile Detection

**Decision point:** `detectWorkloadProfile(objective)` is called.

**Evidence:**
- `server.js` lines 7355-7384: `detectWorkloadProfile()` receives the ticket objective and performs regex matching against five hardcoded patterns:
  - `diagnosis`: `/\b(diagnos|bug|failing test|incorrect assertion|test failure|which test|fix test|broken test)\b/`
  - `refactor`: `/\b(move|rename|restructur|refactor|reorganize|archive|consolidate)\b/`
  - `recommendation`: `/\b(recommend|top [0-9]+|improvement|critical issue|action item|fix plan|roadmap)\b/`
  - `bulk-inventory`: `/\b(list all|catalog|inventory|enumerate|all files|all directories|every file|full list)\b/`
  - `report`: `/\b(report|summary|synthesis|overview|analysis|status|audit)\b/`

**Runtime effects:**
- If a match is found, the profile name is returned (e.g., `'report'`).
- If no match is found, the profile is `null`.
- The profile is not persisted to the ticket. It is computed on demand every time it is needed.

**Prompt effects:** None at detection time.

**Execution effects:** None at detection time.

---

## Stage 3: Runtime Limits

**Decision point:** `getAgentRuntimeLimits(objective)` merges base limits with profile-specific limits.

**Evidence:**
- `server.js` lines 4308-4324:
  ```js
  const profile = detectWorkloadProfile(objective);
  if (profile) {
    return getProfileRuntimeLimits(base, profile);
  }
  ```
- `server.js` lines 7386-7398: `getProfileRuntimeLimits()` takes the base limits and the detected profile, then computes per-profile overrides using `Math.min`:
  - `maxExecutionSteps` = `Math.min(base.maxExecutionSteps, profile.executionStepLimit)`
  - `maxModelRequestsPerRun` = `Math.min(base.maxModelRequestsPerRun, profile.modelRequestLimit)`
  - `maxWorkspaceOperationsPerRun` = `Math.min(base.maxWorkspaceOperationsPerRun, profile.maxWorkspaceOperations)`
  - `maxListDirectoryPerRun` = `profile.maxListDirectory`
  - `maxReadFilePerRun` = `profile.maxReadFile`
  - `profileName` and `profileDescription` are also attached to the returned limits object.

**Runtime effects:**
- A `report` ticket gets: `executionStepLimit: 12`, `modelRequestLimit: 8`, `maxWorkspaceOperations: 32`, `maxListDirectory: 3`, `maxReadFile: 8`.
- A `diagnosis` ticket gets: `executionStepLimit: 12`, `modelRequestLimit: 8`, `maxWorkspaceOperations: 24`, `maxListDirectory: 2`, `maxReadFile: 6`.
- A `refactor` ticket gets: `maxListDirectory: 2`, `maxReadFile: 4`, `allowedOperations` restricted to `['listDirectory', 'readFile', 'renamePath', 'createFolder', 'deletePath']` (no `writeFile`).
- These limits are enforced by `assertRunNotTimedOut()`, `checkRunStepLimit()`, and per-operation counters throughout execution.

**Prompt effects:** None at limit construction time.

**Execution effects:**
- The runtime now holds a different envelope of limits for each detected profile.
- If the agent exceeds `profile.maxListDirectory`, the run logs a limit violation and may terminate.
- If the agent exceeds `profile.maxReadFile`, the same.

---

## Stage 4: Prompt Construction

**Decision point:** `buildAgentPrompt()` calls `buildProfileGuidance()` and injects profile-specific behavioral instructions into the system prompt.

**Evidence:**
- `server.js` line 8381: The system prompt array includes `...buildProfileGuidance(ticket.objective)`.
- `server.js` lines 7402-7459: `buildProfileGuidance()` performs the following:
  1. Calls `detectWorkloadProfile(objective)` again.
  2. If no profile is detected, returns an empty array.
  3. If a profile is detected, looks it up in `WORKLOAD_PROFILES`.
  4. Constructs profile-specific guidance lines:
     - Line 7410: `` `This ticket matches the "${profile.name}" workload profile: ${profile.description}.` ``
     - Line 7411: `` `Use at most ${profile.maxListDirectory} listDirectory calls total. Use at most ${profile.maxReadFile} readFile calls total.` ``
     - Line 7412: `` `Expected phase pattern: ${profile.expectedPhasePattern}.` ``
  5. If `finalArtifactRequired` is true, adds: `'The final response must produce the requested artifact via writeFile.'`
  6. Profile-specific behavioral instructions:
     - `report` (lines 7419-7423): "Cite specific file paths you inspected. Do not invent file contents." "Do not create multiple report files."
     - `diagnosis` (lines 7426-7430): "Focus on identifying the root cause of the bug or test failure." "Explain why each identified assertion is incorrect with evidence from the source code."
     - `refactor` (lines 7433-7441): Four-phase progression (DISCOVER → MUTATE → VERIFY → COMPLETE) with specific rules about listing once, bounded mutation batches, and verification.
     - `recommendation` (lines 7445-7448): "Prioritize the most critical issues." "Link each recommendation to specific evidence."
     - `bulk-inventory` (lines 7452-7455): "Avoid listing every subdirectory individually." "Produce one summary writeFile."

**Runtime effects:** None at prompt construction time.

**Prompt effects:**
- The system prompt sent to the model now contains:
  1. The profile name and description.
  2. Hard numeric caps on `listDirectory` and `readFile` calls.
  3. The expected phase pattern.
  4. Artifact requirements.
  5. Domain-specific behavioral guidance (e.g., "Focus on identifying the root cause" for diagnosis, "Cite specific file paths" for reports).
- The agent receives different instructions based entirely on which regex pattern matched the objective string.
- A ticket with objective containing "report" gets instructions to cite file paths and produce one artifact.
- A ticket with objective containing "refactor" gets instructions to follow a four-phase progression.
- A ticket with objective containing "diagnosis" gets instructions to focus on root cause identification.

**Execution effects:** None at prompt construction time.

---

## Stage 5: Execution

### Decision Point 5a: Phase-Aware Operation Catalog

**Evidence:**
- `server.js` lines 8692-8700: Phase compliance is checked via `checkPhaseCompliance(run, actions)`. The allowed operations for the current phase are determined by `PHASE_OPERATIONS`.
- `server.js` lines 78-83: `PHASE_OPERATIONS` maps each phase to permitted operations:
  - `planning`: `[]`
  - `inspection`: `['listDirectory', 'readFile']`
  - `mutation`: `['writeFile', 'createFolder', 'renamePath', 'deletePath', 'createWorkflowDraft', 'createWorkflowDraftIntent', 'createHandoffTask']`
  - `verification`: `['listDirectory', 'readFile']`

**Profile influence:** The profile's `expectedPhasePattern` (e.g., `'planning → inspection → mutation'` or `'planning → inspection → mutation → verification'`) was injected into the prompt at Stage 4. The agent is expected to follow this pattern. The runtime enforces it by blocking mixed-phase responses and tracking phase transitions.

**Runtime effects:**
- If the agent returns actions from different phases in one response, the response is rejected as `mixed_phase`.
- If the agent tries to `listDirectory` after already mutating (which should be in `verification` or `mutation` phase), the phase is re-inferred and either allowed or blocked based on transition rules.

### Decision Point 5b: Operation Count Enforcement

**Evidence:**
- `server.js` lines 8819-8830: Per-operation counts are tracked and enforced.
- The limits used for enforcement come from `getAgentRuntimeLimits(objective)`, which was computed in Stage 3 and merged the profile-specific caps.

**Profile influence:**
- A `report` profile ticket allows 3 `listDirectory` calls and 8 `readFile` calls.
- A `diagnosis` profile ticket allows 2 `listDirectory` calls and 6 `readFile` calls.
- A `refactor` profile ticket allows 2 `listDirectory` calls and 4 `readFile` calls.
- A `bulk-inventory` profile ticket allows 8 `listDirectory` calls and 4 `readFile` calls.

**Runtime effects:**
- If the agent exceeds the profile-specific `maxListDirectory`, the action is blocked.
- If the agent exceeds the profile-specific `maxReadFile`, the action is blocked.
- These are not global limits; they are profile-differentiated.

### Decision Point 5c: Workflow Execution Mode (Bypass)

**Evidence:**
- `server.js` line 8469: `if (ticket.executionMode === 'workflow' || run.executionMode === 'workflow')`.

**Profile influence:** If `executionMode` is `workflow`, the agent-mode profile system is completely bypassed. The workflow engine executes the `actions` array deterministically. No profile detection occurs during workflow execution.

---

## Stage 6: Completion

**Decision point:** None. The profile has no direct role in completion determination.

**Evidence:**
- `server.js` lines 8786-8814: Completion is determined by the agent's `complete:true` flag and the phase compliance check.
- `server.js` lines 8900-8920: If `complete:true` and actions are successful, the run status is updated to `completed`.

**Profile influence:** None. The profile's `finalArtifactRequired` was used only as a prompt hint; it does not block completion if no artifact was produced. The runtime does not enforce artifact production.

---

## Summary of Profile Influence

| Stage | Decision Points | Runtime Effects | Prompt Effects | Execution Effects |
|---|---|---|---|---|
| **Ticket Creation** | None | None | None | None |
| **Profile Detection** | Regex match on objective string | Profile name returned; not persisted | None | None |
| **Runtime Limits** | `getAgentRuntimeLimits()` merges base + profile limits | Different step/model/op limits per profile | None | Enforced throughout execution |
| **Prompt Construction** | `buildProfileGuidance()` generates type-specific text | None | Profile name, description, numeric caps, phase pattern, artifact requirement, and behavioral instructions injected into system prompt | Agent behavior shaped by prompt text |
| **Execution** | Phase compliance check; per-operation counters | Phase transitions tracked; operation counts enforced against profile caps | None (already injected) | Mixed-phase responses rejected; operation limits enforced |
| **Completion** | Agent `complete:true` flag | Status updated to completed | None | None |

---

## How Much of the System is Organized Around Workload Profiles?

### Quantitative Assessment

| System Component | Profile-Dependent? |
|---|---|
| **Ticket creation UI** | No |
| **Ticket storage** | No (profile is not persisted) |
| **Run creation** | No |
| **Runtime limit computation** | **Yes** — `getAgentRuntimeLimits()` calls `detectWorkloadProfile()` |
| **Agent prompt construction** | **Yes** — `buildAgentPrompt()` calls `buildProfileGuidance()` |
| **Phase compliance enforcement** | **Indirectly** — phase pattern was profile-guided via prompt |
| **Operation count enforcement** | **Yes** — uses profile-specific `maxListDirectory` / `maxReadFile` |
| **Workflow execution** | No — completely bypasses profile system |
| **Replay snapshot** | No |
| **Event logging** | No |
| **Post-execution evaluation** | No |

### Qualitative Assessment

**Workload Profiles are the organizing principle for the agent-mode execution path.** Every agent-mode ticket triggers:
1. Profile detection (regex classification)
2. Profile-specific limit computation
3. Profile-specific prompt injection
4. Profile-specific operation count enforcement

**However, the layer is invisible and ephemeral:**
- The profile is not stored.
- The user does not select it.
- It is recomputed from the objective string every time it is needed.
- It does not survive beyond the individual run.

**For workflow-mode work, the profile system does not exist.** Workflow execution is entirely separate, using the workflow definition's `actions` array and `postconditions`.

### Conclusion

**Approximately 40-50% of the system's runtime behavior for agent-mode work is organized around Workload Profiles.** The profile system governs limits, prompts, and operation counts for the dominant execution path. However, because it is invisible, ephemeral, and bypassed by workflow mode, it does not function as a true system-wide center of gravity. It is the center of gravity for agent-mode execution only.
