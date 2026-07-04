# Browser Target Design — Multi-Target Execution Model

Status: **design only — no implementation until reviewed.**

Goal: keep the existing `local-workspace` filesystem target byte-for-byte unchanged, and add
`browser` as a second **bounded** execution target behind the same
ticket → run → authority → target provider → evidence → verification chain.

---

## 1. Current-state findings

### 1.1 Files inspected

| Area | Location |
| --- | --- |
| Target provider | `server.js:16447` `createLocalWorkspaceProvider`, `server.js:16716` singleton, `server.js:9925` `getRunWorkspaceProvider` (always returns the one local provider), `server.js:9929` `getTargetProviderDescriptor` |
| Operation catalog | `server.js:292-372` — `AGENT_ALLOWED_OPERATIONS` (6 ops), `AGENT_MUTATING_OPERATIONS` (4), `AGENT_OPERATION_ARGS`, `EXECUTION_PHASES` + `PHASE_OPERATIONS` + `ALLOWED_PHASE_TRANSITIONS`, `getAllowedOperationsForPhase` |
| Operation dispatch | `server.js:13915` `executeWorkspaceOperation(run, action, step)` — per-op arg allowlist, authority, ledger idempotency, pre/post state, provider call, history, run log |
| Runtime authority | `server.js:10208` `checkWorkspaceMutationAuthority` (lease → protected paths → owned output paths), `server.js:12889` `blockProtectedWorkspaceOperation`, `server.js:12343` `assertAgentWorkspacePathAllowed`, `config/protected-paths.json` |
| Evidence | `server.js:4800` `appendEvent` → `data/events.jsonl` (append-only); `server.js:4987` `appendRunLog` → `data/logs.json`; `server.js:12964` `persistWorkspaceOperationHistory` → `data/operation-history.json` with `mutationReceipt`; `server.js:9960/10032` read/mutation receipt builders; replay snapshots `DATA_DIR/replay-snapshots/run-<id>.json` (`server.js:8835` `createReplaySnapshotBase`, `appendRunReplaySnapshotItem`) |
| Run loop | `server.js:15448` `runAgentTicket` — async; lease, limits (`maxExecutionSteps`, `maxModelRequestsPerRun`, `maxWorkspaceOperationsPerRun`, `maxRuntimeDurationMs`, `server.js:313-330`), initial target snapshot, resume reconstruction, phase machine, terminalization, `runEvaluation`/`runConsequence` |
| Permissions | `server.js:93` `BUILTIN_PERMISSIONS` (merged with `data/permissions.json` at `server.js:5129`), `server.js:8798` `hasPermission`, route guards (e.g. connector routes `server.js:17504+`) |
| Ticket/run schema | `data/tickets.json` (`executionPolicy`, `capabilityType: directAction|workflow`, `capabilityId`), `data/runs.json` / `.local-data/runs.json` (`workspaceRoot`, `executionWorkspaceType`, `executionPolicySnapshot`, `runtimeLimitsSnapshot`, `verificationContractSnapshot`, lease fields) |
| Second-boundary precedent | Connectors: `docs/CONNECTOR_BOUNDARY_DESIGN_AUDIT.md`, routes `server.js:17509-17618`, `data/connectors.json`, `data/connector-receipts.json` — receipts store metadata + hash only; write refused ("availability is not write authority") |
| Contracts/invariants | `docs/TARGET_PROVIDER_CONTRACT.md`, `docs/EXECUTION_MODEL.md`, `docs/ARCHITECTURE_INVARIANTS.md`, `docs/ALLOWED_OPERATIONS_AUTHORITY.md`, `AGENTS.md` |
| UI | `views/run-detail.ejs` (two-tier evidence groups), `views/workspace.ejs`, `views/admin/runtime-limits.ejs`, `views/connectors.ejs` (admin CRUD pattern) |
| Tests | `scripts/page-render-regression-test.js` (spawns server against temp `DATA_DIR`/`WORKSPACE_ROOT`, HTTP assertions), `scripts/agent-regression-test.js` (mock-model runtime regression), `scripts/catalog-consistency-test.js`, `scripts/local-connector-contract-test.js` |

### 1.2 Current workspace/filesystem operation boundary

- Exactly one target provider exists: `local-workspace` / kind `localWorkspace`, scope
  `{ type: 'filesystemRoot', root: WORKSPACE_ROOT }`, with a declared `capabilities` map.
  `getRunWorkspaceProvider(run)` ignores the run and returns it.
- Agent-proposable operations are exactly `listDirectory, readFile, createFolder, writeFile,
  renamePath, deletePath`, each with a per-op arg allowlist; unknown keys are stripped and logged.
- Every operation passes through `executeWorkspaceOperation`, which enforces (in order):
  arg sanitation → mutation authority (`lease_owner`, `protected_path`, `owned_output_path`) →
  allocated-ownership scope → protected/sensitive path blocks → run-ledger idempotency
  (`findCommittedMutation` / `findConflictingMutation`) → prior-artifact-owner conflict →
  cross-ticket overlap → pre-state capture → provider call → post-state capture →
  operation-history record with `mutationReceipt` → run log.
- The phase machine (`planning → inspection → mutation → verification → terminalization`)
  gates which operations a response may contain; the runtime, not the model, is the authority
  (Invariant #7, and Option A in `ALLOWED_OPERATIONS_AUTHORITY.md`: `runtimeEnvelope.allowedOperations`
  is the stable primitive contract, phase gating is a layer on top).
- Bounds: per-run limits (`maxExecutionSteps`, `maxModelRequestsPerRun`,
  `maxWorkspaceOperationsPerRun`, `maxRuntimeDurationMs`) + per-response caps
  (`MAX_AGENT_ACTIONS_PER_RESPONSE = 8`, `MAX_MUTATING_ACTIONS_PER_RESPONSE = 2`).

### 1.3 Current permission / logging / evidence paths

- **Permissions**: flat strings in `BUILTIN_PERMISSIONS` ∪ `data/permissions.json`, granted via
  groups/users, checked with `hasPermission(userId, perm)` in route guards. Agent runtime authority
  is a separate chain (lease + protected paths + ownership), with denials recorded as
  `authorityChecks` evidence in the replay snapshot.
- **Logging/evidence** (all durable, none renamed by this design):
  - `data/events.jsonl` — append-only events (`workspace.operation`, `run.started`, …).
  - `data/logs.json` — run logs via `appendRunLog` (typed, with `workspaceAction` metadata incl.
    `targetId/targetKind/targetScope`).
  - `data/operation-history.json` — one record per mutating op with `preState`/`postState`,
    target identity fields, `authorityDecision`, `mutationReceipt`.
  - `DATA_DIR/replay-snapshots/run-<id>.json` — frozen run context (`primitiveContract`,
    `targetProvider` descriptor, `executionPolicySnapshot`, `runtimeLimitsSnapshot`) plus
    append streams (`providerRequests`, `modelResponses`, `workspaceOperations`,
    `targetSnapshots`, `authorityChecks`, …).
  - `runEvaluation` / `runConsequence` on the run record.

---

## 2. Proposed model

### 2.1 Target abstraction (smallest interface covering both targets)

The local provider already implicitly defines the contract. Formalize it as **TargetProvider**,
without touching the local implementation:

```
TargetProvider {
  id: string                      // 'local-workspace' | 'browser:<targetConfigId>'
  kind: string                    // 'localWorkspace' | 'browser'
  scope: object                   // filesystemRoot | { type:'originAllowlist', origins, startUrl }
  capabilities: { [opName]: bool }
  // catalog (static per kind):
  //   operations: [name], mutatingOperations: [name], operationArgs: { name: [argKeys] },
  //   phaseOperations: { inspection|mutation|verification: [name] }
}
```

Selection and dispatch:

- `getRunWorkspaceProvider(run)` **stays exactly as is** and remains the accessor used by every
  existing filesystem code path.
- New `getRunTargetProvider(run)`: returns the browser provider when
  `run.targetRef.kind === 'browser'`, else `getRunWorkspaceProvider(run)`.
- New thin dispatcher used only by the agent run loop:
  `executeTargetOperation(run, action, step)` → routes to the **untouched**
  `executeWorkspaceOperation` for filesystem runs, or to new async
  `executeBrowserOperation` for browser runs. No shared mutable state; no change to the
  filesystem call graph.
- A per-kind **operation catalog** replaces the hardcoded assumption that
  `AGENT_ALLOWED_OPERATIONS` is the only catalog: the run loop, `buildRuntimeEnvelope`,
  prompt phase guidance, and preflight validation read the catalog from the run's target kind.
  For filesystem runs the catalog is literally the existing constants, so behavior is identical.

This is the extension point for later higher-level browser skills / workflow templates: skills
compose the same catalog operations; autonomy layers sit **above** the target, never inside it.

### 2.2 Browser target config

Stored in `data/browser-targets.json` (admin-managed, like connectors). Ephemeral runtime state
(browser session) is never stored there.

```
BrowserTarget {
  id: number
  name: string
  status: 'active' | 'paused' | 'archived'
  allowedOrigins: string[]        // exact origins ('https://host[:port]'); no wildcards in v1
  startUrl: string                // must parse to an origin in allowedOrigins
  sessionMode: 'ephemeral'        // phase 3 adds 'persistent'
  credentialRef: string | null    // reference into env/secret store; never a secret. Phase 3.
  artifactDir: string | null      // relative subdir override; default 'browser-artifacts/run-<id>'
                                  // resolved under DATA_DIR — never under WORKSPACE_ROOT
  limits: {
    maxNavigationsPerRun: number      // default 8
    maxActionsPerRun: number          // default 24 (all browser ops count)
    maxInteractionsPerRun: number     // default 8 (click/fill/press)
    navTimeoutMs: number              // default 10000
    waitTimeoutMsCap: number          // default 10000
    maxPageTextBytes: number          // default 65536 (truncation marked in receipt)
    maxDownloadBytes: number          // default 10485760 (phase 3)
    maxScreenshotsPerRun: number      // default 12
  }
  workContextId: number | null
  createdBy/createdAt/updatedBy/updatedAt
}
```

The ticket references a target: additive optional field `ticket.targetRef =
{ kind: 'browser', browserTargetId }`; absent ⇒ filesystem (today's behavior, unchanged).
At run creation the resolved config is **snapshotted** onto the run
(`run.targetRef`, `run.browserTargetSnapshot`) and into the replay snapshot — config edits never
reinterpret old runs.

Engine: a lazy-loaded wrapper module (`runtime/browser-engine.js`) around `playwright-core`
(or `puppeteer-core`) with an explicit executable path env (`BROWSER_ENGINE_EXECUTABLE`).
The server must boot and all existing paths must work with the dependency absent; a browser run
without an engine fails fast with `BROWSER_TARGET_UNAVAILABLE`. Origin enforcement is done at the
engine level (request interception + navigation guard), not only at op-argument level, so
redirects and subresource requests outside `allowedOrigins` are blocked and recorded.

### 2.3 Browser operations

`AGENT_BROWSER_OPERATIONS` — the primitive contract for browser runs (mirrors
`AGENT_OPERATION_ARGS` style; unknown args stripped + logged):

| Operation | Args | Tier | Notes |
| --- | --- | --- | --- |
| `navigate` | `{ url }` | inspection | `url` origin must be in `allowedOrigins`; final URL + redirect chain recorded; counts against `maxNavigationsPerRun` |
| `observe` | `{}` | inspection/verification | Returns `{ url, title, elements: [{ elementId, role, name, text≤200, enabled }] }`, bounded element count; assigns run-scoped stable `elementId`s and records an **observation receipt** (pageStateHash) |
| `readPageText` | `{}` | inspection/verification | Normalized visible text, truncated at `maxPageTextBytes`, receipt carries size/hash/truncated |
| `screenshot` | `{}` | inspection/verification | PNG written to artifact dir; receipt carries path + sha256 |
| `wait` | `{ forMs }` | inspection/verification | Clamped to `waitTimeoutMsCap` |
| `click` | `{ elementId }` | **mutation** | `elementId` must come from a prior `observe` in this run; staleness checked against pageStateHash |
| `fill` | `{ elementId, value }` | **mutation** | Same element rule; values matching a credential-marked field are stored redacted (`{ redacted: true, valueHash }`) |
| `press` | `{ key }` | **mutation** | Key allowlist (`Enter`, `Tab`, `Escape`, arrows) |
| `downloadArtifact` | `{ elementId }` | **mutation** (phase 3) | Saves to artifact dir; size cap; receipt has filename/bytes/sha256 |

Rules the runtime (not the model) enforces:

- **No blind selectors.** `click`/`fill`/`downloadArtifact` may only reference `elementId`s
  minted by `observe`. This is the browser analogue of "inspect before mutate" and yields an
  evidence chain: every interaction points back to the observation that justified it.
- Mutating tier requires `executionPolicy.allowBrowserInteractions === true` on the ticket
  (default **false** ⇒ read-only run) plus the runtime authority check (§2.6).
- The existing phase machine is reused unchanged: `PHASE_OPERATIONS` gains a browser variant
  (inspection/verification = observe/readPageText/screenshot/navigate/wait; mutation =
  click/fill/press/downloadArtifact). `DISCOVER → MUTATE → VERIFY` semantics are identical.
- All ops count toward `maxActionsPerRun`; interactions additionally toward
  `maxInteractionsPerRun`; per-response caps (`MAX_AGENT_ACTIONS_PER_RESPONSE`,
  `MAX_MUTATING_ACTIONS_PER_RESPONSE`) apply as-is.

### 2.4 Browser failure states

Structured errors in the style of `createStructuredWorkspaceError` (code + `failureKind`),
persisted to operation history with a failed `mutationReceipt` where applicable:

| Code | failureKind | Trigger / behavior |
| --- | --- | --- |
| `BROWSER_TARGET_UNAVAILABLE` | `target_unavailable` | Engine missing/launch failed; run fails before any op |
| `BROWSER_ORIGIN_BLOCKED` | `protected_path` | navigate arg, redirect, or in-page navigation leaves `allowedOrigins`; navigation aborted, evidence recorded, op fails (recoverable: agent may propose an in-bounds alternative) |
| `BROWSER_NAV_LIMIT_EXCEEDED` / `BROWSER_ACTION_LIMIT_EXCEEDED` / `BROWSER_INTERACTION_LIMIT_EXCEEDED` | `limit_exceeded` | Budget exhausted → run terminalizes (same semantics as `maxWorkspaceOperationsPerRun`) |
| `BROWSER_ELEMENT_NOT_FOUND` | `browser_error` | `elementId` unknown (never observed) — invalid action |
| `BROWSER_ELEMENT_STALE` | `browser_error` | Page state changed since the observation that minted the id; recoverable — re-`observe` |
| `BROWSER_TIMEOUT` | `browser_error` | Navigation/wait/interaction timeout; recoverable once, then fail |
| `BROWSER_SESSION_LOST` | `browser_error` | Crash/disconnect; run fails (no silent relaunch — session identity is evidence) |
| `BROWSER_DOWNLOAD_TOO_LARGE` / `BROWSER_DOWNLOAD_BLOCKED` | `browser_error` | Cap exceeded / cross-origin download source |
| `BROWSER_CREDENTIAL_UNAVAILABLE` | `target_unavailable` | `credentialRef` set but unresolvable; refuse before launch |
| `BROWSER_INTERACTION_NOT_AUTHORIZED` | `authority_denied` | Mutation-tier op without `allowBrowserInteractions`; recorded as authority denial evidence |

Interrupted browser runs do **not** resume mid-session (a dead browser session is not
reconstructable state): `reconstructResumableState` treats a run with browser operations and a
non-terminal phase as safe only for terminal-state reconciliation, mirroring the existing
"unsafe to continue" path.

### 2.5 Evidence requirements (every browser run)

1. **Run-start snapshot**: replay snapshot gains `targetRef` + `browserTargetSnapshot`
   (config incl. limits, origins, startUrl) alongside the existing `targetProvider` descriptor.
2. **Every operation** (read or mutating): `browser.operation` event in `events.jsonl`,
   run-log entry (`browser:navigate`, `browser:observe`, `browser:click`, … with target metadata
   analogous to `buildWorkspaceActionMetadata`), and a replay-snapshot item under a new
   `browserOperations` key (same shape discipline as `workspaceOperations`).
3. **Read receipts** for observe/readPageText/screenshot: url, title, pageStateHash,
   size/hash of text, truncation flags, artifact path + sha256 for screenshots — no full page
   content persisted in events or receipts (content goes to the model turn and, bounded, to the
   replay snapshot only as today's `modelResponses` already do).
4. **Mutation receipts** for click/fill/press/download: pre-state `{ url, title, pageStateHash }`,
   post-state same, the observation receipt id that minted the `elementId`, `authorityDecision`,
   and **before/after screenshots** (paths + hashes). Fill values: plaintext only for
   non-credential fields; credential-marked fields redacted with hash.
5. **Navigation trace**: each navigate records requested URL, final URL, redirect chain,
   HTTP status; blocked requests (origin violations) recorded with the blocked URL.
6. **Artifacts** under `DATA_DIR/browser-artifacts/run-<id>/` (ignored by git like the rest of
   `.local-data`), never under `WORKSPACE_ROOT`; every artifact referenced from a receipt with
   sha256 + bytes. Deleting artifacts never invalidates the receipt record.
7. **Terminal evidence**: unchanged — `runEvaluation`/`runConsequence`, terminal status, and
   snapshot finalization apply as-is; final `observe` in the verification phase is the
   browser analogue of the final workspace listing.

### 2.6 Fit to the existing system model

| Primitive | Browser mapping |
| --- | --- |
| **Ticket** | Unchanged unit of intent; optional `targetRef` selects the browser target; `executionPolicy.allowBrowserInteractions` / `allowBrowserDownloads` (both default false) are the explicit authorization for state-changing web actions |
| **Scope** | `allowedOrigins` + startUrl (the analogue of `WORKSPACE_ROOT` + protected paths + ownedOutputPaths); enforced at engine level |
| **Target** | `BrowserTarget` config → one `TargetProvider` instance per run, id `browser:<configId>`, kind `browser` |
| **Resource** | URL (navigation/read receipts) and observed element (`elementId` bound to an observation receipt) — recorded in the existing `targetResourceId` field |
| **Operation** | The 9-op catalog above, same arg-allowlist/sanitize/phase/limit machinery |
| **Evidence** | Same four stores (events, logs, operation-history, replay snapshot) + artifact dir; receipts follow the `readReceipt`/`mutationReceipt` shapes from `TARGET_PROVIDER_CONTRACT.md` |
| **Verification** | Deterministic post-checks per interaction (element existed, post-state captured), a `verifyBatchOperation` analogue (e.g. after navigate: final origin in allowlist; after click: post pageStateHash captured), and the existing verification phase (observe/readPageText) before terminalization; `runEvaluation` unchanged |
| **Permissions (user-facing)** | New: `browserTarget:manage` (CRUD config), `browser:run` (open a ticket targeting browser), `browser:interact` (create tickets with `allowBrowserInteractions`), `browser:download` (phase 3). Mirrors the connector precedent: target availability is never mutation authority |
| **Runtime authority (agent)** | New `checkBrowserMutationAuthority(run, op, args)` mirroring `checkWorkspaceMutationAuthority`: lease held → target status active → executionPolicy allows interaction → interaction budget → element provenance; allow/deny recorded via `recordAuthorityEvidence` into `authorityChecks` |

Scalability note: higher-level browser skills, workflow templates (browser-step workflows), and
more autonomous planning later compose these same nine operations through the same authority,
evidence, and verification chain — a "skill" is a validated plan over catalog ops (exactly how
`executeActionPlan` wraps filesystem ops today), never a new privileged pathway.

---

## 3. Minimal implementation plan

### Phase 1 — read-only browser target
1. Schema: `data/browser-targets.json` store (+ `seedOperationalDataDir` entry), validation,
   CRUD API gated by `browserTarget:manage`; additive `ticket.targetRef`; run snapshot fields.
2. `runtime/browser-engine.js`: lazy engine wrapper (launch ephemeral context, origin guard via
   request interception, navigate/observe/readPageText/screenshot/wait, close). No interaction API exposed.
3. `server.js`: browser op catalog constants; `getRunTargetProvider`; `executeBrowserOperation`
   (async) with read receipts, events, run logs, `browserOperations` replay key;
   run-loop branch (envelope, prompt phase guidance, preflight validation, counters, initial
   `observe` as the run-start target snapshot); failure codes; permissions additions.
4. Tests: `scripts/browser-target-regression-test.js` — local fixture HTTP server on loopback
   (its origin allowlisted), mock model (pattern from `agent-regression-test.js`); asserts
   receipts, origin blocking, limits, engine-absent refusal. Skips cleanly when no engine binary.
5. Exit criteria: a browser ticket runs navigate/observe/readPageText/screenshot and completes;
   all existing suites (`npm run build`, `test:workflow`, `test:postcondition`,
   `page-render-regression-test`, `catalog-consistency-test`) pass unchanged.

### Phase 2 — safe interaction
1. `click`/`fill`/`press` in engine + dispatcher as mutation-tier ops.
2. `checkBrowserMutationAuthority`; `executionPolicy.allowBrowserInteractions` (ticket form +
   validation, default false); `browser:interact` permission.
3. Element provenance: `observe` mints ids + pageStateHash; interactions validate provenance and
   staleness; mutation receipts with before/after screenshots; operation-history records.
4. Deterministic post-interaction verification checks; verification-phase prompting.
5. Tests: authorized vs unauthorized interaction, stale element, redirect-after-click leaving
   allowlist (blocked + evidenced), interaction budget exhaustion.

### Phase 3 — downloads / session handling
1. `downloadArtifact` with size cap into artifact dir; `browser:download` +
   `executionPolicy.allowBrowserDownloads`.
2. `sessionMode: 'persistent'`: named storage-state file under `DATA_DIR/browser-sessions/`
   (git-ignored), loaded/saved per run with receipts recording session identity (never contents).
3. `credentialRef` resolution (env-var reference in v1), redacted fill evidence.
4. Tests: download caps, session reuse receipts, no plaintext secret anywhere in
   events/logs/history/replay.

### Phase 4 — UI / admin / testing refinements
1. `views/admin/browser-targets.ejs` (clone connectors admin pattern) + nav entry.
2. `views/run-detail.ejs`: browser evidence group in the existing two-tier layout — navigation
   trace, screenshot gallery (operator tier), receipts/raw ops (collapsed developer tier).
3. `views/ticket-detail.ejs` / `views/tickets.ejs`: show target + interaction authorization.
4. `scripts/page-render-regression-test.js` additions; `scripts/oquery.js` + `codex:trace`
   browser-run rendering; docs (`BROWSER_TARGET_CONTRACT.md`, AGENTS.md evidence locations).

---

## 4. Required changes

- **Schema** (all additive): `data/browser-targets.json` (new); `ticket.targetRef`,
  `executionPolicy.allowBrowserInteractions/allowBrowserDownloads`; `run.targetRef`,
  `run.browserTargetSnapshot`; replay snapshot `browserOperations`, `browserTargetSnapshot`;
  operation-history records reuse existing columns (`targetId/targetKind/targetScope/targetPath/
  targetResourceId`, `mutationReceipt`).
- **Runtime**: `runtime/browser-engine.js` (new); in `server.js`: browser catalog constants,
  `getRunTargetProvider`, `executeTargetOperation` dispatch used only at the run-loop call sites
  of `executeWorkspaceOperation` for direct-action runs, async `executeBrowserOperation`,
  `checkBrowserMutationAuthority`, browser receipt builders, envelope/prompt/preflight reading
  the per-kind catalog, resume guard for browser runs, failure codes.
- **Permissions**: append `browserTarget:manage`, `browser:run`, `browser:interact`,
  `browser:download` to `BUILTIN_PERMISSIONS` (+ tracked `data/permissions.json`).
- **Logging/evidence**: new event/log types (`browser.operation`, `browser:*`), artifact dir
  under `DATA_DIR`, redaction rule for credential fills.
- **UI**: admin browser-targets page, run-detail browser evidence group, ticket target display.
- **Tests**: new `browser-target-regression-test.js`; targeted additions to
  `page-render-regression-test.js`, `catalog-consistency-test.js`; a
  `no-plaintext-credential` assertion test (pattern: `no-tracked-provider-keys-test.js`).
- **Dependency**: `playwright-core` (or `puppeteer-core`) + `BROWSER_ENGINE_EXECUTABLE` env;
  optional at runtime, absence degrades to refusal.

## 5. Non-changes

- `createLocalWorkspaceProvider`, `executeWorkspaceOperation`, `getRunWorkspaceProvider`,
  workspace authority chain, ownership/overlap rules, phase machine, limits semantics,
  replay/event/log/history field names — untouched.
- Workflows (`executeActionPlan`/`executeTicketPlan`), connectors, watchers, handoff, model
  routing, work contexts — untouched; browser workflow steps are deferred.
- Intentionally deferred: general-purpose browsing (wildcard origins), persistent sessions and
  credentials until phase 3, browser workflow actions/skills/templates, multi-tab, iframes
  beyond same-origin, cross-run browser artifact ownership, watcher observation of pages,
  any auto-retry of browser mutations.

## 6. Risks and open questions (blocking only)

1. **Engine dependency**: `playwright-core` vs `puppeteer-core`, and where the Chromium binary
   comes from (system package vs downloaded). Recommendation: `playwright-core` +
   `BROWSER_ENGINE_EXECUTABLE`; needs reviewer sign-off because it's the repo's first heavy dep.
2. **Sync vs async dispatch**: `executeWorkspaceOperation` is sync and called from sync helpers in
   a few places. The executor must branch **before** it (at the run-loop/dispatch level, which is
   already async) rather than making the filesystem path async.
3. **pageStateHash definition**: hash of normalized DOM text + element inventory. Live pages are
   nondeterministic; staleness checks must be advisory-strict (fail the op, recoverable) — reviewer
   should confirm this tolerance is acceptable vs hard-failing runs on any DOM churn.
4. **Where interaction authorization lives**: this design puts it on
   `ticket.executionPolicy` (per-ticket, snapshotted to the run) rather than on the target config.
   Confirm before phase 2.

## 7. Executor handoff

Execute phases in order; each phase ends with `npm run build`, the phase's new test,
`node scripts/page-render-regression-test.js`, `npm run test:workflow`,
`npm run test:postcondition`, `node scripts/catalog-consistency-test.js` — all green, plus a
manual `npm run dev` smoke of one filesystem ticket to prove no regression.

Proposed file-level change list:

| File | Change |
| --- | --- |
| `server.js` | Constants block (~line 292): add `AGENT_BROWSER_OPERATIONS`, `BROWSER_MUTATING_OPERATIONS`, `BROWSER_OPERATION_ARGS`, `PHASE_BROWSER_OPERATIONS`, failure codes; permissions (~line 93); browser-target store helpers + validation (pattern: connectors, ~line 17504); `getRunTargetProvider` next to `getRunWorkspaceProvider` (~line 9925); browser receipt builders next to `buildTargetReadReceipt` (~line 9960); `checkBrowserMutationAuthority` next to `checkWorkspaceMutationAuthority` (~line 10208); async `executeBrowserOperation` after `executeWorkspaceOperation` (~line 14247); run-loop branch in `runAgentTicket` (~line 15506: envelope/prompt/snapshot/counters + dispatch); resume guard (~line 15582); CRUD + admin routes; `seedOperationalDataDir` (~line 149) |
| `runtime/browser-engine.js` | New lazy engine wrapper; only module that imports the browser library |
| `data/browser-targets.json`, `data/permissions.json` | New empty store; permission strings |
| `views/admin/browser-targets.ejs`, `views/layout.ejs` | Phase 4 admin CRUD + nav |
| `views/run-detail.ejs`, `views/ticket-detail.ejs`, `views/tickets.ejs` | Browser evidence group; target display; interaction-authorization display |
| `scripts/browser-target-regression-test.js` | New; loopback fixture server + mock model |
| `scripts/page-render-regression-test.js`, `scripts/catalog-consistency-test.js` | Targeted additions |
| `docs/BROWSER_TARGET_CONTRACT.md`, `AGENTS.md` | Contract doc after phase 1; evidence-locations update |

Hard rules for the executor: never modify the six filesystem operations or their authority chain;
never write browser artifacts under `WORKSPACE_ROOT`; never persist page content or credentials
in events/logs/history; every new operation must produce a receipt before its result is returned
to the model; deny-by-default for every mutation-tier capability.
