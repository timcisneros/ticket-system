# Browser Target Design — Review Pass and Phase 1 Executor Spec

Scope: review of `docs/BROWSER_TARGET_DESIGN.md` against the current repo. No runtime code was
edited. This narrows Phase 1 to the minimum viable read-only slice and pins the exact insertion
points. Where this document and the design doc disagree, **this document wins for Phase 1**.

---

## 1. Claim verification

### 1.1 Verified as fact (re-checked at cited locations this pass)

| Claim | Anchor | Status |
| --- | --- | --- |
| Single provider; `getRunWorkspaceProvider(run)` ignores `run` | `server.js:9925-9927` | ✅ |
| Six-op catalog, arg allowlists, mutating set, per-response caps | `server.js:292-311` | ✅ |
| `executeWorkspaceOperation` order-of-checks as described | `server.js:13915-14247` | ✅ |
| Authority chain lease → protected_path → owned_output_path, denials recorded | `server.js:10208-10248` | ✅ |
| Phase machine constants; phase compliance rejects only mixed-phase + terminalization | `server.js:357-396, 857-898` | ✅ |
| Evidence stores: `events.jsonl` (`appendEvent` :4800), `logs.json` (:4987), `operation-history.json` with `mutationReceipt` (:12964-13002), replay at `DATA_DIR/replay-snapshots/run-<id>.json` (:68, :5281) | | ✅ |
| `workspace.operation` event + `workspaceOperations` replay item shapes | `server.js:16139-16166` | ✅ |
| `targetId/targetKind/targetScope/targetPath/targetResourceId` already on history records | `server.js:9938-9948, 12995` | ✅ |
| Permissions = `BUILTIN_PERMISSIONS` ∪ `data/permissions.json`; route guards via `hasPermission` | `server.js:93-120, 5129, 8798` | ✅ |
| Connector routes/receipts exist; write refused; receipts metadata+hash only | `server.js:17504-17618` | ✅ |
| `runAgentTicket` is `async`, has `catch` + `finally` | `server.js:15448, 16424-16441` | ✅ |
| Run record built in `createAgentRun` with snapshot fields; additive fields feasible | `server.js:~11890-11940` | ✅ |
| Limits + `assertRunWorkspaceOperationAllowed` | `server.js:313-330, 9353` | ✅ |
| Option-A envelope semantics (primitive contract, phase gating layered) | `docs/ALLOWED_OPERATIONS_AUTHORITY.md` | ✅ |

### 1.2 Corrections — claims that were imprecise or wrong

1. **Dispatch anchor.** Design §7 said "run-loop branch (~line 15506)". The single direct-action
   dispatch site is **`server.js:16103`** (`result = executeWorkspaceOperation(run, action, step)`).
   Lines 15506-15508 are the envelope/prompt build sites, a separate change. The design also
   under-enumerated the filesystem-coupled sites inside the loop — the full list is in §4 below.
2. **Artifact git-ignore.** Design claimed browser artifacts under `DATA_DIR` are "ignored by git
   like the rest of `.local-data`". Only true when `DATA_DIR=.local-data` (dev). Under `npm start`,
   `DATA_DIR` is the tracked `data/` directory; `.gitignore` carves out `data/replay-snapshots/`
   etc. explicitly. **An explicit `data/browser-artifacts/` entry in `.gitignore` is required.**
3. **Connector precedent overstated.** Connectors are route-level only (`ticketId/runId` are
   always `null` in their receipts); they never enter the run loop. They are a valid precedent for
   the *boundary/receipt/permission shape*, not for run-integrated target selection. The browser
   target is the **first** second target inside the run loop — there is no existing dispatch seam
   to copy; it must be created (at :16103).
4. **Run completion for read-only runs.** The design implied the phase machine "maps cleanly" and
   left completion unstated. In fact every non-`complete:true` completion path is
   filesystem-specific: the no-progress detector keys on `listDirectory`/`readFile` names
   (`server.js:16355-16361`), `isDirectWorkspaceObjectiveSatisfied` requires mutation evidence
   (:16339), and postcondition completion gates on mutating actions (:9377). A read-only browser
   run therefore terminates **only** via the model's `complete:true` (:16412) or limit/timeout
   errors. Acceptable for Phase 1, but the executor and the test must account for it: an
   inspection-looping browser model will burn steps to `maxExecutionSteps` without a no-progress
   warning. Extending `PHASE_OPERATIONS`/no-progress lists with browser op names is additive and
   safe (new names cannot match filesystem actions) — included in the spec.
5. **Operation counting.** The loop increments `workspaceOperationCount` only for
   `AGENT_ALLOWED_OPERATIONS`/`createHandoffTask` (:16111). The design's "separate browser
   counters" left the existing run-level limit uncounted for browser ops. Phase 1 rule: browser
   ops increment the **same** counter (so `maxWorkspaceOperationsPerRun` stays a global op
   ceiling) *and* decrement browser-specific budgets from the target config.

### 1.3 Inference markers — design proposals, not repo facts

These are sound but have no grounding in existing code; treat all as reviewable proposals:
the formalized `TargetProvider` interface (only the descriptor shape exists today); the entire
`BrowserTarget` config schema **including every default limit number**; the `elementId`
provenance rule; `pageStateHash`; all `BROWSER_*` failure codes; the choice of `playwright-core`
+ `BROWSER_ENGINE_EXECUTABLE`; engine-level origin interception; session non-resumability; the
four proposed permissions; the browser phase mapping. Nothing in the repo constrains these
choices except the invariants (bounded, receipts, deny-by-default, runtime authority).

---

## 2. Phase 1 — minimum viable slice (narrowed)

Read-only browser target. No interaction, no downloads, no credentials, no persistent sessions,
no UI beyond run inspection.

**In scope**

- `data/browser-targets.json` — hand-edited/seeded store. Minimal record:
  `{ id, name, status, allowedOrigins, startUrl, limits: { maxNavigationsPerRun, maxActionsPerRun, navTimeoutMs, waitTimeoutMsCap, maxPageTextBytes, maxScreenshotsPerRun } }`.
  **No CRUD API, no admin UI** — creating a target means editing the JSON file. That file is the
  authorization gate in Phase 1.
- `ticket.targetRef` (optional, `{ kind: 'browser', browserTargetId }`), validated at ticket
  creation: target must exist and be `active`; **rejected when `executionMode === 'workflow'`**
  (keeps the workflow/handoff call sites at :13630/:14601/:14894 unreachable for browser).
- Run fields `targetRef` + `browserTargetSnapshot` (resolved config frozen at `createAgentRun`).
- `runtime/browser-engine.js` — lazy wrapper; ephemeral context; request-interception origin
  guard; exactly five ops: `navigate`, `observe`, `readPageText`, `screenshot`, `wait`.
- Async `executeBrowserOperation` + read receipts + `browser.operation` events + `browser:*` run
  logs + `browserOperations` replay stream + screenshots under `DATA_DIR/browser-artifacts/run-<id>/`.
- Failure codes actually reachable in Phase 1: `BROWSER_TARGET_UNAVAILABLE`,
  `BROWSER_ORIGIN_BLOCKED`, `BROWSER_NAV_LIMIT_EXCEEDED`, `BROWSER_ACTION_LIMIT_EXCEEDED`,
  `BROWSER_TIMEOUT`, `BROWSER_SESSION_LOST`.
- UI: **one** read-only evidence block in `views/run-detail.ejs` rendering `browserOperations`
  (operation, resource/url, status, hash, artifact path as text). No artifact-serving route —
  screenshots are inspected on disk via the recorded path.

**Explicitly deferred (from the design doc's own Phase 1)**

- All four new permissions (`browserTarget:manage` has nothing to guard without CRUD routes).
  Tradeoff accepted for Phase 1: target creation requires filesystem access to the data dir,
  which is a stronger gate than any in-app permission. Revisit when CRUD lands (Phase 4).
- CRUD/admin routes and pages; `oquery`/`codex:trace` rendering.
- `executionPolicy.allowBrowserInteractions/allowBrowserDownloads` (no interactions exist yet).
- `sessionMode`, `credentialRef`, `artifactDir` override, `maxInteractionsPerRun`,
  `maxDownloadBytes` — not stored until the phase that uses them.
- Action-catalog (`GENERATED_AGENT_ACTIONS` :1192) entries — browser ops are not workflow-usable;
  the run loop validates them directly; `catalog-consistency-test.js` stays untouched.
- New runtime-limit admin keys — browser budgets come from the target config only.

---

## 3. Exact async insertion point

- **Dispatch**: `server.js:16103`. The statement sits inside `for (const action of actions)`
  (:16061) inside `for (let step...)` (:15635), both directly within
  `async function runAgentTicket` — no intermediate sync function, so
  `result = isBrowserRun(run) ? await executeBrowserOperation(run, action, step) : executeWorkspaceOperation(run, action, step);`
  is legal, and the per-action `try/catch` (:16064) handles an awaited rejection identically to a
  sync throw. `verifyBatchOperation` (:16105) stays filesystem-only (gated on
  `AGENT_MUTATING_OPERATIONS`, which contains no browser ops).
- **Parse**: branch at :16072 — `parseAgentDirectAction` is left untouched; browser runs call a
  new `parseBrowserDirectAction` (op ∈ browser catalog, arg allowlist, unknown-arg strip+log).
- **Untouched call sites**: :13630 (handoff), :14601 (`executeActionPlan`), :14894 (workflow
  step) — unreachable for browser runs by ticket validation (§2).
- **Session lifecycle**: open lazily on the first browser op; store in a module-level
  `Map<runId, session>`; close best-effort in the existing `finally` at :16437-16441 (plus on
  `completeAgentRun`/`failAgentRun` return), recording a `browser.session_closed` event. No
  session state persists; `reconstructResumableState` needs **no change** in Phase 1 — read-only
  runs have no committed mutations, so the existing resume logic cannot replay browser state
  incorrectly; the relaunched run simply re-navigates. (Design §2.4's resume guard becomes
  necessary only in Phase 2.)

**All filesystem-coupled sites in the loop needing a browser branch** (the design under-listed
these; verified line-by-line):

| Site | Line | Phase 1 handling |
| --- | --- | --- |
| `buildRuntimeEnvelope` | :12095 (called :15506) | Browser branch: `allowedOperations` = browser catalog; origins/startUrl instead of `workspaceRoot`; `workloadProfile: null` |
| `buildAgentPrompt` | :15331 (called :15507 and per-step) | Browser branch producing a minimal browser instruction block; filesystem prompt untouched |
| Initial snapshot `captureRunWorkspaceRootSnapshot` | :15574 | Replace with `browserTargetSnapshot` record into `targetSnapshots` |
| `checkObviousTicketPostcondition` | :15647 | Skip for browser runs |
| Per-step `currentWorkspaceSnapshot` | :15677 | Browser: current `{url, title}` from session (or null before first navigate) |
| `assertRunWorkspaceOperationAllowed` / counter | :16059, :16111 | Count browser ops in `workspaceOperationCount`; additionally enforce target-config budgets inside `executeBrowserOperation` |
| No-progress detector | :16355 | Add browser read ops to the inspection-only check (additive; string names can't collide) |
| `isDirectWorkspaceObjectiveSatisfied` / postcondition completion | :16339, :16400 | No-op for browser (no mutations); verify by test, don't modify |
| Completion | :16412 | Read-only browser runs complete via `complete:true` — must be covered by the prompt text and asserted in the test |

One implementation-time check (not a code change yet): `runObjectiveClarificationGate` runs for
all direct-action tickets in `createRunsForTicket`. The Phase 1 test objective must pass this
gate; if browser-style objectives are systematically blocked as ambiguous, a targetRef-aware
bypass is a runtime change that needs separate review — do not add it preemptively.

---

## 4. Schema additions — required vs deferred for Phase 1

**Required**: `data/browser-targets.json` (+ entry in `seedOperationalDataDir` :149-177);
`ticket.targetRef`; `run.targetRef` + `run.browserTargetSnapshot`; replay snapshot keys
`browserOperations` + `browserTargetSnapshot` (in `createReplaySnapshotBase` :8835);
`.gitignore` line `data/browser-artifacts/`; new event/log type strings; one dependency decision
(`playwright-core`, lazy-required only from `runtime/browser-engine.js`, `BROWSER_ENGINE_EXECUTABLE` env).

**Deferred**: everything in §2 "explicitly deferred". No changes to `data/permissions.json`,
`config/protected-paths.json`, `runtime-limits.json`, workflows, connectors, watchers, or any
existing evidence field name.

---

## 5. Phase 1 test gate

All of the following, in order, must pass:

1. **Existing suites unchanged**: `npm run build`, `npm run test:workflow`,
   `npm run test:postcondition`, `node scripts/page-render-regression-test.js`,
   `node scripts/catalog-consistency-test.js`, and `npm run test:agent` (primary filesystem
   regression) — zero assertion changes to any of them.
2. **New `scripts/browser-target-regression-test.js`** (temp `DATA_DIR` + `WORKSPACE_ROOT` +
   loopback fixture HTTP server, mock model — same harness pattern as
   `page-render-regression-test.js` / `agent-regression-test.js`):
   - **Origin rejection**: navigate to a non-allowlisted loopback origin →
     `BROWSER_ORIGIN_BLOCKED`, no page load, failure recorded in events + logs + replay.
   - **Allowed navigation**: navigate to the allowlisted fixture → receipt with requested URL,
     final URL, status.
   - **Observe / readPageText / screenshot**: each returns bounded results; receipts carry
     size/hash/truncation; screenshot file exists on disk and its sha256 matches the receipt;
     oversized fixture page sets `truncated: true`.
   - **Durable evidence**: `events.jsonl` contains `browser.operation` entries; `logs.json`
     contains `browser:*` entries; replay snapshot contains `browserTargetSnapshot` and a
     non-empty `browserOperations`; run reaches `completed` via `complete:true`.
   - **Budget enforcement**: exceeding `maxNavigationsPerRun` fails with
     `BROWSER_NAV_LIMIT_EXCEEDED`.
   - **Engine absent**: with `BROWSER_ENGINE_EXECUTABLE` unset/invalid, a browser run fails fast
     with `BROWSER_TARGET_UNAVAILABLE` (this sub-test always runs); live sub-tests skip cleanly
     with a visible SKIP when no engine is available.
   - **Filesystem non-regression in-process**: one filesystem ticket run in the same test asserts
     normal completion and that its run/replay contain no browser keys.

---

## 6. Phase 1 executor spec

Rules: never modify `createLocalWorkspaceProvider`, `executeWorkspaceOperation`,
`parseAgentDirectAction`, the authority chain, or any existing evidence field. Every browser
operation writes its receipt/log/event **before** its result is returned to the model. All
additions are additive; a repo with no browser targets behaves byte-for-byte as today.

Steps (one commit each, existing suites green after every step):

1. **Store + schema**: `data/browser-targets.json` (empty array, tracked); add to
   `seedOperationalDataDir`; `readBrowserTargets`/`getBrowserTargetById` helpers;
   `ticket.targetRef` validation in ticket creation (`server.js:16953+` area) — exists, active,
   not workflow; snapshot `targetRef` + `browserTargetSnapshot` onto the run in `createAgentRun`;
   add `browserOperations: []` + `browserTargetSnapshot: null` to `createReplaySnapshotBase`;
   `.gitignore` += `data/browser-artifacts/`.
2. **Engine wrapper**: `runtime/browser-engine.js` — lazy `require('playwright-core')`
   (decision pending review; must not be imported anywhere else), launch via
   `BROWSER_ENGINE_EXECUTABLE`, per-session request interception aborting any request whose
   origin is outside `allowedOrigins` (recording the blocked URL), and the five read ops with
   bounded outputs. Export `isEngineAvailable()`.
3. **Runtime constants + dispatcher**: `AGENT_BROWSER_OPERATIONS = ['navigate','observe','readPageText','screenshot','wait']`,
   `BROWSER_OPERATION_ARGS`, browser names added to `PHASE_OPERATIONS.inspection/verification`
   (mutation list unchanged in Phase 1); `parseBrowserDirectAction`; async
   `executeBrowserOperation(run, action, step)` (after :14247) — arg sanitize → target budgets →
   engine call → read receipt (pattern of `buildTargetReadReceipt` :9960 with
   `targetKind: 'browser'`, `targetResourceId` = URL) → `appendRunLog` + `appendEvent('browser.operation')`
   + `appendRunReplaySnapshotItem('browserOperations', …)` → return bounded result; structured
   errors with the six Phase 1 codes.
4. **Run-loop integration**: the nine branch sites in §3's table, dispatch at :16103 with
   `await`, session registry + close in the `finally` at :16437.
5. **Evidence surface**: screenshots to `DATA_DIR/browser-artifacts/run-<id>/step-<n>-<seq>.png`,
   sha256 + bytes in the receipt; run-detail.ejs read-only `browserOperations` block (developer
   tier, collapsed, following the existing evidence-group markup).
6. **Test**: `scripts/browser-target-regression-test.js` per §5; wire nothing into `package.json`
   scripts beyond `"test:browser-target"`.

Exit criteria: §5 gate fully green; `npm run dev` manual smoke of one filesystem ticket and one
browser ticket (fixture server) showing unchanged filesystem behavior and inspectable browser
evidence on the run page.

**Blocking decisions — RESOLVED (approved by reviewer, 2026-07-03)**:

1. **Engine dependency — approved**: `playwright-core`, system Chromium via
   `BROWSER_ENGINE_EXECUTABLE`, lazy-loaded only from `runtime/browser-engine.js`; if
   unavailable, fail fast with structured `BROWSER_TARGET_UNAVAILABLE` refusal evidence; no
   bundled browser binaries.
2. **Authorization gate — approved**: hand-edited `data/browser-targets.json` is the Phase 1
   gate; no admin CRUD, no new permission catalog entries, no `executionPolicy` browser flags.
3. **Completion rule — approved**: read-only browser runs complete only through model
   `complete:true` or limits; filesystem-specific no-progress detection and
   objective-satisfaction logic are not altered.

This document controls Phase 1 wherever it differs from `BROWSER_TARGET_DESIGN.md`.
