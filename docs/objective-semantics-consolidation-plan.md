# Objective Semantics Consolidation Plan

Status: **planning only (v0.1.26)** — no runtime/behavior change in this slice.
Baseline: `v0.1.25-exact-delete-target-absent-guard` (`4127f498fece027a599905282b51a08ff89110e1`), release checkpoint 22/22.
Source: the v0.1.25 semantic short-circuit / deterministic guard audit.

## 1. Problem Statement

Runtime code in `server.js` currently contains **multiple independent natural-language
interpreters of the ticket objective string**. Each one inspects `ticket.objective`
with its own regex/keyword heuristics to decide things like "is this an already-satisfied
delete?", "is this a direct write objective that is now satisfied?", "is this a report?",
or "what exact path should be deleted?".

Because each interpreter is separate, every new objective wording tends to add **another
regex or another branch** to a different function. This is an open-ended edge-case pattern:
the v0.1.25 exact-delete guard fixed one wording, but the same shape will recur for the next
phrasing ("erase X", "remove the folder named X", "delete everything under X", …). Left
distributed, objective interpretation grows without bound and becomes hard to test, reason
about, or freeze.

The fix is **not** broader NLP. The fix is to **centralize objective interpretation** into one
deterministic, table-driven contract module so that future objective forms extend a single
table with a single test surface, instead of adding one-off short-circuits across the runtime.

## 2. Current Risk Surface

The audited objective/semantic findings (file:line as of this baseline):

| ID | Helper | File:line | Current role | Timing | Skip model? | Complete run? | Prevent mutation? | Parses objective? | Risk | Planned disposition |
|----|--------|-----------|--------------|--------|-------------|---------------|-------------------|-------------------|------|---------------------|
| F1 | `buildObviousPostconditionChecks` / `checkObviousTicketPostcondition` | server.js:6914 / 6982 | Pre-model "already satisfied" detection (create/ensure/delete-absent) → completes run before any model call | pre-model | yes | yes | yes (no mutation needed) | yes | **med-high** | Centralize into objective-contract postconditions |
| F2 | `extractSimpleDeleteTargets` | server.js:6905 | Extracts the exact delete target from simple delete objectives; feeds F1 absent-check and F12 mismatch guard | pre-model + pre-execution | indirectly | indirectly | indirectly (wrong-target prevention) | yes | med | Centralize as contract target extraction |
| F4 | `workflow.draft_objective_satisfied` (uses `isWorkflowDraftObjective`) | server.js:12468 (+ `isWorkflowDraftObjective`) | Completes run when a workflow-draft objective is met by a created disabled draft | in-loop (post-action) | no | yes | n/a | yes | med | Centralize completion policy; keep draft execution distributed |
| F5 | `isDirectWorkspaceObjectiveSatisfied` / `isDirectWorkspaceWriteObjective` | server.js:10183 / 10070 | NL write-objective heuristic + mutation evidence → completes run without explicit `complete:true` | in-loop | no | yes | allows (already done) | yes | **med-high** | Centralize completion policy via contract |
| F6 | `checkPostconditionCompletion` / all-redundant-mutation summary | server.js:6782 (+ ~6823) | Completes run when proposed mutations are all redundant/no-op or declared postconditions met | in-loop | no | yes | prevents redundant | partly (postcondition derived) | med | Centralize postconditions; keep no-op detection distributed |
| F12 | exact delete-target mismatch guard | server.js:~12207 (event `workspace.delete_target_mismatch_rejected` @12227) | Rejects a `deletePath` whose target ≠ the objective's exact target, before execution | pre-execution | no | no (rejects batch) | prevents mutation | via F2 | med | **Safety guard stays distributed**, but its objective-target *input* comes from the contract |
| F17 | `inferObjectiveRequiredWritableRoots` | server.js:7535 | Infers required writable roots from objective text for owned-scope feasibility | pre-run / run start | no | no (can block ticket) | prevents (scope) | yes | med | Centralize the objective→scope hint derivation; keep the scope assertion distributed |
| F22 | `isReportObjective` / `getReportRuntimeLimits` (+ `detectWorkloadProfile`) | server.js:10080 / 10085 | NL keywords → tighter runtime limits/profile | run start | no | no | n/a | yes | low-med | Centralize objective→runtimeProfile mapping |
| F23 | `suggestBoundedTicketObjective` | server.js:8648 | Advisory objective suggestion at the ticket-creation API | pre-ticket (API) | n/a | n/a | n/a | yes | low | Keep advisory; may reuse contract vocabulary but is not a runtime short-circuit |

Supporting/objective-adjacent helpers that will move or be referenced by the contract:
`cleanObjectivePath` (6828), `cleanObjectiveContent` (6835), `parseSimpleFolderListObjective`
(6843), `extractObjectivePathTokens` / `normalizeObjectivePathToken` (10050 / 10033),
`hasSuccessfulObjectiveMutationEvidence` (10149), `assertAllocatedObjectiveSupported` (7627).

## 3. Boundary Rule

> **Runtime safety invariants may remain distributed where needed. Objective semantics must be centralized.**

**Keep distributed (safety invariants — Class A from the audit; unchanged):**
- phase validation / mixed-phase rejection (`checkPhaseCompliance`)
- invalid-action arg preflight (`validateWorkspaceActionBatch`)
- workspace path scope (`assertAgentWorkspacePathAllowed`)
- owned output / allocation scope assertions (`assertTicketObjectiveWithinGrantedWritableRoots`, `assertAllocatedTicketCanStart`, `assertAllocatedObjectiveSupported`)
- permission checks (`hasPermission`, `assertAgentOperationAllowed`)
- cross-ticket ownership/conflict guards (`assertNoCrossTicketOverlap`, `findOverlappingSuccessfulArtifactOwner`, `findPriorSuccessfulArtifactOwner`)
- mutation/step/timeout/model-request/workspace-op budget limits
- replay/resume integrity (`reconstructResumableState`, `reconcileTerminalRun`)
- the exact-delete **mismatch rejection** (F12) — stays a runtime guard; only its target *input* comes from the contract
- idempotent `already_exists_noop` / `already_missing_noop` execution results

**Centralize (objective semantics):**
- objective text parsing / intent recognition
- exact target extraction
- deterministic postconditions ("already satisfied" detection)
- allowed completion shortcuts (which intents may complete without `complete:true`)
- objective-specific runtime limits / workload profile
- objective-derived writable scope hints

## 4. Proposed Objective Contract Module

Future module: **`objective-contract.js`** — a pure, deterministic, side-effect-free function
that converts an objective string into a structured contract. It performs **no** workspace I/O,
no event writes, and no completion decisions itself; runtime callers consume the contract and
apply existing distributed guards.

Example shape:

```json
{
  "source": "objective-contract",
  "recognized": true,
  "intent": "delete",
  "targetPath": "CD",
  "postconditions": [
    { "type": "path_absent", "path": "CD" }
  ],
  "allowedMutations": [
    { "operation": "deletePath", "path": "CD" }
  ],
  "completionPolicy": "idempotent_if_already_satisfied",
  "scopeHints": [],
  "runtimeProfile": null
}
```

For an unrecognized objective:

```json
{ "source": "objective-contract", "recognized": false, "intent": null,
  "targetPath": null, "postconditions": [], "allowedMutations": [],
  "completionPolicy": "model_driven", "scopeHints": [], "runtimeProfile": null }
```

Contract field semantics (planned):
- `recognized`: whether any deterministic form matched (false ⇒ normal model path).
- `intent`: e.g. `delete` | `create_folder` | `ensure_folder` | `direct_write` | `workflow_draft` | `report` | `null`.
- `postconditions`: declarative checks the runtime evaluates against current workspace state (`path_absent`, `path_exists`, `folder_exists`, `file_contains`).
- `allowedMutations`: optional exact-target allow-list used by the mismatch guard (delete intent only, today).
- `completionPolicy`: `idempotent_if_already_satisfied` | `complete_on_mutation_evidence` | `model_driven`.
- `scopeHints`: objective-derived writable roots (feeds the *existing* distributed scope assertion).
- `runtimeProfile`: e.g. `report` (feeds the *existing* limit selection).

## 5. Supported Objective Forms

Only the forms the codebase **already** recognizes today (no new forms in any slice of this plan):

| Form | Recognizer today | Intent | Status |
|------|------------------|--------|--------|
| `ensure folder X exists` | `buildObviousPostconditionChecks` | ensure_folder | stable |
| `create folder X` (+ simple folder lists) | `buildObviousPostconditionChecks` / `parseSimpleFolderListObjective` | create_folder | stable |
| `create file X containing exactly …` | `buildObviousPostconditionChecks` | direct_write | stable |
| `delete\|remove [the] [file\|folder\|directory\|path] X` | `extractSimpleDeleteTargets` (+ absent check, mismatch guard) | delete | stable (v0.1.25) |
| direct workspace write objectives (`write\|create\|update … note\|summary\|report\|file` / path tokens) | `isDirectWorkspaceWriteObjective` / `isDirectWorkspaceObjectiveSatisfied` | direct_write | provisional (keyword heuristic) |
| workflow draft objectives | `isWorkflowDraftObjective` / `isWorkflowDraftPromptObjective` | workflow_draft | legacy |
| report/summary objectives | `isReportObjective` / `getReportRuntimeLimits` / `detectWorkloadProfile` | report | provisional |
| objective→required writable roots | `inferObjectiveRequiredWritableRoots` | (scope hint) | needs review |

Marking key: **stable** (well-formed, tested), **legacy** (works, predates this plan), **provisional**
(keyword heuristic, candidate for tightening), **needs review** (inference whose breadth should be re-examined).

## 6. Unsupported Forms

Free-form or unrecognized objectives **must not** acquire new one-off regex branches in the
runtime. An objective the contract does not recognize returns `recognized:false` /
`completionPolicy:model_driven` and flows through the **normal model → action → runtime-validation
→ execution** path unchanged. New deterministic behavior is added **only** by extending the
objective-contract table (with tests), never by inserting another bespoke short-circuit in
`server.js`.

## 7. Migration Plan

1. **Add `objective-contract.js`** (pure functions) with **no behavior change** — not yet wired into runtime.
2. **Move** the existing objective regex/keyword helpers (F1, F2, F4-recognizer, F5, F6 postcondition derivation, F17, F22) into the module, preserving exact current semantics.
3. **Add tests** proving the contract reproduces today's behavior for every supported form (golden tests against current outputs).
4. **Replace** direct runtime calls with contract consumption: the run loop reads the contract; existing distributed guards (phase, preflight, scope, ownership, mismatch) keep enforcing.
5. **Document** every supported contract form in this file (and keep it the single source of truth).
6. **Freeze** legacy helpers: remove duplicated regex logic from `server.js` once the contract is the sole interpreter; keep thin wrappers only if needed.
7. **Promote** the contract test(s) into `scripts/release-checkpoint.js`.

Each step is its own reviewable slice; behavior parity is the gate between steps.

## 8. Test Plan

Provider-free tests (extend existing harness style) to cover at minimum:
- exact delete target **absent** → idempotent completion, zero mutation (parity with v0.1.25).
- exact delete target **present** → normal `deletePath` executes.
- **non-exact** delete rejected before execution (mismatch guard, fed by contract target).
- `ensure folder X exists` → already-satisfied completion when present.
- direct workspace write objective → completion on mutation evidence.
- workflow draft objective → completion on created disabled draft.
- report objective → report runtime profile/limits selected.
- **unsupported / free-form** objective → `recognized:false`, falls through to the normal model path (no short-circuit, no spurious completion).

## 9. Non-Goals

- No new objective behavior.
- No broader NLP / fuzzy matching.
- No additional short-circuit branches in `server.js`.
- No permission, cross-ticket delete, ownership/conflict, or phase changes.
- No runtime broadening.
- No event-log maintenance.

## 10. Acceptance Criteria for This Planning Slice

- [x] The plan exists (`docs/objective-semantics-consolidation-plan.md`).
- [x] It references all known objective interpreters from the audit (F1, F2, F4, F5, F6, F12, F17, F22, F23).
- [x] It separates safety invariants (stay distributed) from semantic objective interpretation (centralize).
- [x] It defines the future consolidation target (`objective-contract.js` + contract shape).
- [x] It recommends **no runtime changes** in this slice.
- [x] Release checkpoint still passes (22/22).
