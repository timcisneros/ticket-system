# Objective Semantics Consolidation — Closure

Status: **closure audit (v0.1.32)** — documentation + test-only. No runtime/behavior change.
This closes the initial consolidation arc opened by the v0.1.26 plan
(`docs/objective-semantics-consolidation-plan.md`).

## 1. Baseline

- Tag: `v0.1.31-objective-contract-report-wiring`
- Commit: `6731393f9277c61a10daaf09e67eb2c6bc107ac2`
- `master` = `origin/master` = the above; local branches: `master` only.
- Release checkpoint: **23/23**.
- `data/events.jsonl`: untracked + ignored, 0 bytes / 0 lines
  (sha `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).

Arc opened at `v0.1.25-exact-delete-target-absent-guard` (audit) → v0.1.26 plan → v0.1.27 module →
v0.1.28–v0.1.31 runtime wiring (this closure).

## 2. What Was Consolidated

The arc moved the duplicated, deterministic objective-string interpreters out of `server.js`
and into the single pure module `objective-contract.js`, one reviewable slice per helper family,
behavior parity as the gate between slices:

| Slice | Tag | What was wired |
|-------|-----|----------------|
| v0.1.27 | `v0.1.27-objective-contract-parity` | `objective-contract.js` introduced (pure `buildObjectiveContract`) with golden parity tests; **not** wired into runtime |
| v0.1.28 | `v0.1.28-objective-contract-delete-wiring` | delete extraction wired (`extractSimpleDeleteTargets` → contract) |
| v0.1.29 | `v0.1.29-objective-contract-folder-wiring` | folder-list parsing wired (`parseSimpleFolderListObjective` → contract) |
| v0.1.30 | `v0.1.30-objective-contract-single-ensure-wiring` | single ensure-folder recognizer wired (inside `buildObviousPostconditionChecks` → contract) |
| v0.1.31 | `v0.1.31-objective-contract-report-wiring` | report detection + report runtime-limit shaping wired (`isReportObjective`, `getReportRuntimeLimits` → contract) |

The four objective-semantics helper families now single-sourced through `objective-contract.js`:

1. **delete extraction** — the simple `delete|remove [the] [file|folder|directory|path] X` grammar.
2. **folder-list parsing** — the conservative `ensure|create folder(s) X [Y …]` list grammar
   (dedup + per-path validation + connector/prose blocklist).
3. **single ensure-folder recognition** — the single `ensure folder X exists` recognizer.
4. **report detection / report runtime-limit shaping** — the standalone report-keyword boolean
   and the report runtime-limit object.

No new objective grammar was introduced in any slice; each wiring preserved the exact historical
return shape, truthiness, and runtime behavior (verified by the parity test + release checkpoint).

## 3. Compatibility Wrappers Left in server.js

`server.js` still **owns runtime flow**. It retains thin compatibility wrappers that delegate to
the contract, so call sites and behavior are unchanged:

| Wrapper (server.js) | Delegates to (objective-contract.js) | Return shape preserved |
|---------------------|--------------------------------------|------------------------|
| `extractSimpleDeleteTargets(objective)` | `buildObjectiveContract(objective)` (delete intent) | array of target path, or `null` |
| `parseSimpleFolderListObjective(text, command)` | `parseSimpleFolderListObjective` (exported) | array of folder paths, or `null` |
| `buildObviousPostconditionChecks` (single ensure-folder recognizer only) | `buildObjectiveContract(text)` (`ensure_folder` → `folder_exists`) → `addFolderPostconditionChecks` | `{ type: 'folder', path, satisfied }` checks |
| `isReportObjective(objective)` | `isReportObjective` (exported) | `boolean` |
| `getReportRuntimeLimits(baseLimits)` | `getReportRuntimeLimits` (exported) | exact merged limits object |

`buildObviousPostconditionChecks` itself remains in `server.js` and still owns the obvious
postcondition list; only its single ensure-folder recognizer delegates. `addFolderPostconditionChecks`
is the unchanged producer of folder checks.

## 4. Parity / Migration Guards

`scripts/objective-contract-parity-test.js` is in the release checkpoint (23/23) and enforces:

- **Behavior parity** — `buildObjectiveContract` outputs for each supported form (delete, ensure/create
  folder, single ensure-folder, report) plus folder-wrapper output shapes, report-detection parity
  (vs. an inline legacy reference, 12 inputs), and report runtime-limit parity (vs. an inline legacy
  reference, multiple bases).
- **Migration guards** — each of the four families: the grammar fragment lives in
  `objective-contract.js` and **not** in the corresponding `server.js` wrapper body, and the wrapper
  delegates to the contract. Shape-preservation guards confirm the single ensure-folder delegation is
  scoped to `ensure_folder`/`folder_exists` and routes through the unchanged `addFolderPostconditionChecks`.
- **Closure audit (v0.1.32)** — a source-level block asserting all four wrappers delegate, that **no
  "still mirrored objective-semantics" guard/list remains**, and that `detectWorkloadProfile` is still a
  separate helper not counted as objective-semantics consolidation.

The earlier per-slice "still mirrored" drift list (which tracked not-yet-migrated families) was emptied
as each family migrated and was fully removed at v0.1.31. There is no remaining mirrored
objective-semantics grammar to drift-guard.

## 5. Remaining Explicitly Out of Scope

These were identified in the v0.1.26 audit but are **not** part of this consolidation pass. They remain
distributed in `server.js` and are intentionally untouched:

- **F1** — broad postcondition construction (`buildObviousPostconditionChecks` beyond the single
  ensure-folder recognizer; create-file `containing exactly` recognizers, delete-absent checks, dedup).
- **F4 / F5 / F6** — completion policy / direct workspace objective satisfaction
  (`isDirectWorkspaceWriteObjective`, `isDirectWorkspaceObjectiveSatisfied`, redundant-mutation /
  postcondition completion, workflow-draft completion).
- **F17** — objective→writable-scope-hint inference (`inferObjectiveRequiredWritableRoots`).
- **`detectWorkloadProfile`** — an independent workload-profile classifier that happens to reuse the
  same report-keyword set to return the `'report'` profile. It is **not** the `isReportObjective`
  family and was deliberately left in place; it is the only remaining report-keyword copy in `server.js`.

Runtime **safety invariants** (Class A: phase compliance, invalid-action preflight, path scope,
ownership/cross-ticket conflict, permissions, budgets, the exact-delete **mismatch rejection** guard,
idempotent no-op execution results) stay distributed by design — per the v0.1.26 boundary rule, only
objective *semantics* are centralized, not safety enforcement.

## 6. Why Runtime Wiring Stops Here

The four families migrated in this arc share a property: each is a **pure, deterministic recognizer of
already-supported objective wording** with an exact, testable return shape. Migrating them removed the
duplicated regex/keyword logic with provable zero behavior change.

The remaining items (F1/F4/F5/F6/F17, `detectWorkloadProfile`) are **not** pure recognizers — they make
completion decisions, infer scope, evaluate mutation evidence, or shape runtime profiles, and are
entangled with runtime state and control flow. Consolidating them is a larger design decision (contract
`completionPolicy`, `scopeHints`, and `runtimeProfile` consumption) that must each be its own reviewable
slice with its own parity gate. Bundling them into this arc would mix mechanical de-duplication with
behavioral redesign and break the "behavior parity is the gate between steps" discipline.

## 7. Future Slice Boundaries

Each is a separate future slice (not started), gated by the same parity/drift discipline:

1. **F17 scope-hint inference** → contract `scopeHints`, consumed by the *existing* distributed scope
   assertion (no scope-enforcement change).
2. **`detectWorkloadProfile`** → contract `runtimeProfile`, consumed by the *existing* limit selection
   (no limit redesign).
3. **F1 broad postcondition construction** → contract `postconditions` for the create-file / delete-absent
   forms, consumed by `buildObviousPostconditionChecks` / `checkObviousTicketPostcondition`.
4. **F4 / F5 / F6 completion policy** → contract `completionPolicy`, consumed by the run loop; the
   exact-delete mismatch guard and other Class A safety guards stay distributed.

No future slice introduces new objective grammar; new deterministic behavior is added only by extending
the contract table with tests, never by adding a bespoke `server.js` short-circuit.

## 8. Release-Gate Status

- Release checkpoint: **23/23** (includes `objective-contract-parity-test.js` and
  `exact-delete-target-absent-guard-test.js`).
- Stress: parity + exact-delete + checkpoint, **5/5**.
- `data/events.jsonl`: unchanged (untracked + ignored, 0 bytes / 0 lines).
- This slice changes only `docs/objective-semantics-consolidation-closure.md` and
  `scripts/objective-contract-parity-test.js` (closure audit block). `server.js` and
  `objective-contract.js` are unchanged.

## 9. Acceptance Criteria

- [x] The four objective-semantics helper families are single-sourced through `objective-contract.js`.
- [x] `server.js` retains thin compatibility wrappers and still owns runtime flow.
- [x] Behavior parity preserved (parity test + release checkpoint 23/23, stress 5/5).
- [x] No "still mirrored objective-semantics" guard/list remains.
- [x] Remaining audit items (F1, F4/F5/F6, F17, `detectWorkloadProfile`) are documented as separate,
      out-of-scope future slices.
- [x] No runtime behavior change, no new objective grammar, no event-log maintenance in this slice.
