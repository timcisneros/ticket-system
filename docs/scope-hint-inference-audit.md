# Scope-Hint Inference Audit (F17)

Status: **audit / documentation only (v0.1.33)** — no runtime/behavior change, nothing migrated.
Follows the closure of the initial objective-semantics consolidation arc
(`docs/objective-semantics-consolidation-closure.md`, v0.1.32). This slice audits the
F17 "scope-hint inference" area to decide whether any part should later move into
`objective-contract.js`.

## 1. Baseline

- Tag: `v0.1.32-objective-semantics-closure-audit`
- Commit: `e71cd5f2103400bc92bfadbba4be30e9ec47f8dd`
- `master` = `origin/master` = the above; local branches: `master` only.
- Release checkpoint: **23/23**.
- `data/events.jsonl`: untracked + ignored, 0 bytes / 0 lines
  (sha `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).

## 2. Search Method

Commands (run from repo root, excluding `node_modules`, `.git`, `.local-data`):

- `rg -n "scope|scopeHint|scope_hint|hint|infer|inference|…|allowed|visible|context" …`
- `rg -n "inferObjectiveRequiredWritableRoots" server.js objective-contract.js scripts`
- `rg -n "scopeHints|scope_hint|scopeHint" server.js objective-contract.js scripts docs`
- `rg -n "WritableRoots|writableRoots|grantedWritable|RequiredWritable" server.js`
- `rg -n "function infer" server.js`
- purity check: `rg -n "require\(|workspaceProvider|fs\.|list\(|appendEvent" objective-contract.js`

Terms searched: `scope`, `scopeHint(s)`, `scope_hint`, `infer*`, `WritableRoots`,
`grantedWritable`, `quarter`, `month`, `Q\d+`, `allowed`, `visible`, `context`.

Files inspected: `server.js`, `objective-contract.js`, `scripts/*`, `docs/*`.

## 3. Current Scope-Hint Surfaces

There is exactly **one** objective→scope inference surface in the codebase:

- `inferObjectiveRequiredWritableRoots(ticket)` — `server.js:7517`.

The contract field `scopeHints` exists in `objective-contract.js` but is an **always-empty
placeholder** (`scopeHints: []` on every returned contract); it is **not consumed by any
runtime caller** today. The other `infer*` functions (`inferPhaseFromActions:600`,
`inferActionType:1228`) classify actions/phases, not objective scope, and are unrelated.

## 4. Functions / Fields Found

| Name | File:line | Role |
|------|-----------|------|
| `inferObjectiveRequiredWritableRoots(ticket)` | server.js:7517 | The F17 inference. Returns required writable roots derived from the objective. |
| `getTicketGrantedWritableRoots(ticket, agents)` | server.js:7528 | Computes granted roots from the allocation ownership plan (not objective-derived). |
| `assertTicketObjectiveWithinGrantedWritableRoots(ticket, agents)` | server.js:7548 | Feasibility gate: required ⊆ granted, else throws. |
| `createTicketFeasibilityError(...)` | server.js:7537 | Builds the `TICKET_FEASIBILITY_MISSING_GRANTS` error. |
| `blockTicketForFeasibility(ticket, error, context)` | server.js:7561 | Blocks the ticket on the thrown error (writes ticket + events). |
| `scopeHints` (contract field) | objective-contract.js (5 sites) | Always `[]`; unused placeholder. |

Inference internals (the only objective-semantics part is the keyword trigger):

```js
function inferObjectiveRequiredWritableRoots(ticket) {
  const objective = String(ticket && ticket.objective || '').toLowerCase();
  if (!objective.includes('quarter') || !objective.includes('month')) return [];   // pure keyword trigger
  const rootListing = workspaceProvider.list('');                                  // LIVE workspace I/O
  return rootListing.entries
    .filter(entry => entry && entry.type === 'folder' && /^Q\d+$/i.test(entry.name))
    .map(entry => normalizeWorkspaceOwnershipPath(entry.path))
    .sort((a, b) => a.localeCompare(b));
}
```

## 5. Callers and Consumers

- **Caller:** `assertTicketObjectiveWithinGrantedWritableRoots` (server.js:7549) →
  `inferObjectiveRequiredWritableRoots(ticket)`.
- **Consumer / runtime path:** `assertTicketObjectiveWithinGrantedWritableRoots` is called at
  `server.js:8392`, inside the `usesOwnedScopeAllocation(ticket)` branch of run dispatch. On a
  feasibility violation it throws; the caller catches and calls `blockTicketForFeasibility(ticket, error)`
  and returns `[]` (no runs created).
- Persisted outputs of the gate (`requiredWritableRoots`, `grantedWritableRoots`,
  `missingAuthorityGrants`) are stored on `ticket.feasibility` and surfaced via the
  `ticket.blocked` event / feasibility system log.

## 6. Inputs and Return Shapes

- **Inputs read:** `ticket.objective` (string, lowercased) for the keyword trigger; **live workspace
  root listing** (`workspaceProvider.list('')`) for the actual roots.
- **Output produced:** an array of normalized root paths (e.g. `["Q1","Q2",…]`) or `[]` when the
  trigger does not match.
- **Return shape:** `string[]` (sorted, normalized). Empty array means "no objective-required roots".
- **Persistence / logging impact:** `inferObjectiveRequiredWritableRoots` itself is **read-only**
  (no writes, no events). The **downstream** `blockTicketForFeasibility` (only on a violation)
  writes the ticket and appends a `ticket.blocked` event + feasibility system log.

## 7. Runtime / Permission / Mutation Effects

- **Permission impact:** indirect but real — it feeds a **feasibility/authority gate** that can
  **block a ticket** before any run starts. It does not change permission *policy*; it enforces that
  the objective's required roots are within the allocation's granted owned-output roots.
- **Mutation impact:** no workspace mutation. The blocking path mutates *ticket state* (status →
  `blocked`) and emits events.
- **Completion impact:** none (pre-run gate; it prevents run creation, it does not complete runs).
- **Provider/model impact:** none.
- **Event-log impact:** none from the inference itself; the **blocking** path appends `ticket.blocked`.

Classification of the helpers: `getTicketGrantedWritableRoots`, `buildAllocatedOwnershipPlan`,
`isPathInsideOwnedOutputPaths`, `normalizeWorkspaceOwnershipPath`, `usesOwnedScopeAllocation` are
**ownership/allocation safety logic (Class A)** — not objective semantics — and per the v0.1.26
boundary rule stay distributed.

## 8. Duplication and Drift Risk

- **Duplicated logic?** No. The objective keyword trigger (`'quarter'` + `'month'` + `/^Q\d+$/i`)
  appears in exactly **one** place (`server.js:7519,7523`). The other `month` matches in `server.js`
  (8471+, 13672) are unrelated date formatting.
- **Exact duplicated fragments?** None.
- **Drift risk level:** **low**. Unlike the four families consolidated in v0.1.28–v0.1.31 (which each
  had a mirrored copy that could silently diverge), this logic is single-sourced already. There is no
  mirror to drift against, so the usual consolidation payoff (eliminating drift) does not apply here.

## 9. Consolidation Suitability

**Classification: D — Mixed.**

Reason: `inferObjectiveRequiredWritableRoots` is two things stitched together:

1. A **pure objective-semantics trigger** — "does this objective ask for quarter/month scope?"
   (a string keyword test). This *could* in principle become a contract signal (e.g. a `scopeHints`
   entry or an intent flag).
2. An **impure runtime derivation + policy** — it enumerates **live workspace state**
   (`workspaceProvider.list('')`) and feeds an authority/feasibility gate that can block tickets.
   `objective-contract.js` is, by explicit invariant, **pure and side-effect-free** (confirmed: no
   `require`, `fs`, `workspaceProvider`, `list(`, or `appendEvent`). The workspace enumeration and the
   feasibility/blocking decision **cannot** move into the contract without breaking that invariant, and
   they are Class A runtime policy that the boundary rule says to keep distributed.

So the only consolidatable sub-part is the small pure keyword trigger — and it has **no duplication**,
so consolidating it now yields little benefit and adds an indirection. The bulk (root enumeration +
feasibility gate + blocking) is **B — keep distributed**.

## 10. Explicitly Out of Scope

This slice did **not**, and a future slice for this area should not without separate review:
move any function into `objective-contract.js`; change objective parsing; change ticket routing;
change workspace visibility; change permissions; change mutation validation; change completion policy;
change provider prompts/context; change event logging; or add tests asserting new behavior.

## 11. Recommended Next Slice

**Recommendation: audit-only conclusion → keep F17 distributed for now; no migration slice yet.**

- The pure trigger is not duplicated, so there is no drift to eliminate; the runtime/I-O/policy bulk
  must stay distributed by the boundary rule. Net consolidation value today is **low**.
- Defer until a *second* objective-derived scope form appears. The migration trigger for this program
  has consistently been **duplication / drift**, which does not yet exist for scope hints.
- If/when a second scope form appears, the minimal future slice would be:
  **`v0.1.x — Wire objective scope-hint trigger to objective contract`** — extract only the **pure
  predicate** ("objective requests dated/quarter scope") into the contract as a `scopeHints` signal,
  leave `workspaceProvider.list('')` enumeration and `assertTicketObjectiveWithinGrantedWritableRoots`
  (the feasibility gate + blocking) distributed and unchanged, with a parity test proving the predicate
  matches the historical `'quarter' && 'month'` trigger exactly.
- The contract's existing `scopeHints: []` placeholder remains an accurate "not wired yet" marker.

A reasonable immediate follow-up instead of F17 wiring: a parallel **audit-only** slice for the next
out-of-scope item (`detectWorkloadProfile` → `runtimeProfile`, which *is* a pure recognizer and a
closer analog to the already-consolidated families).

## 12. Acceptance Criteria

- [x] The single F17 scope-hint inference surface is located and documented
      (`inferObjectiveRequiredWritableRoots`, server.js:7517).
- [x] Its inputs, outputs, callers/consumers, and runtime/permission/event effects are documented.
- [x] Duplication/drift assessed (none; low risk).
- [x] Classified (D — Mixed: small pure trigger vs. distributed runtime/policy bulk).
- [x] A clear next-slice recommendation is given (keep distributed; defer migration).
- [x] No runtime change, no migration, no new objective grammar, no event-log maintenance.
- [x] Release checkpoint still passes (23/23); only `docs/scope-hint-inference-audit.md` changed.
