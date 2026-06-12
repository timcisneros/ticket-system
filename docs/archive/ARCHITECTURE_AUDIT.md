# Substrate/Runtime Architecture Audit

**Scope:** Operational adaptability, boundary quality, swappability, maintenance pressure, portability, runtime coupling.
**Perspective:** Brutally honest operational evaluation. No framework purity. No enterprise abstraction fantasies.

---

## Executive Summary

The system is **not** a generic operational substrate. It is a **well-governed filesystem/ticket application** with strong substrate-like qualities in the bounded execution and replay layers, but those qualities are inseparable from the application's domain assumptions.

The runtime core (bounded loops, replay, provenance) *could* become substrate, but it would require decoupling from three things that are currently hard-wired:
1. The model IO contract (JSON shape, provider APIs)
2. The workspace action vocabulary (filesystem CRUD)
3. The prompt text that teaches the model about both of the above

The good news: the architecture is **honest about its coupling**. There are no fake abstractions, no adapter interfaces that hide leaks, no premature plugin systems. The bad news: this honesty means you cannot swap domains or providers without touching runtime semantics.

---

## 1. Provider Boundary

### Current State

Provider interaction lives in three functions:
- `callModelProvider(agent, input, options)` — a switch on `agent.provider`
- `callOpenAI(agent, input, options)` — OpenAI Responses API, `input` array, `text.format.type: 'json_object'`
- `callOllama(agent, input, options)` — Ollama chat API, `messages` array, `format: 'json'`

### Verdict: Leaky, Not Abstracted

**What leaks:**
- **Request shape divergence.** OpenAI uses `input: [{role, content}]`. Ollama uses `messages: [{role, content}]`. The `buildAgentPrompt` function returns `input`, which `callOllama` must silently reinterpret. This is not normalization — it is tolerance.
- **Response extraction.** `extractOpenAIText` handles three OpenAI response formats (`output_text`, `output[].content[].text`, `choices[0].message.content`). Ollama uses `data.message.content` or `data.response`. There is no unified `extractModelText(data)` — each provider parses its own structure.
- **JSON enforcement.** OpenAI uses native `json_object` text format. Ollama uses `format: 'json'`. These have different failure modes, different escape behaviors, different whitespace handling. The runtime does not shield the loop from this.
- **Error taxonomy.** Provider errors carry provider-specific codes (`OPENAI_TRANSPORT_ERROR`, `OLLAMA_TRANSPORT_ERROR`, `OPENAI_HTTP_ERROR`, `OLLAMA_HTTP_ERROR`). The runtime classifies them all as `failureKind: 'provider_error'`, which is fine, but the *codes* propagate into replay snapshots and operator-visible logs. An operator must know which provider was used to interpret a failure.
- **Token usage shape.** OpenAI returns `usage: {input_tokens, output_tokens, total_tokens}`. Ollama returns `usage: {prompt_eval_count, eval_count, total_duration}`. The runtime stores whatever the provider returns. There is no normalized usage model.

**What would break if you added Claude/Anthropic:**
- Claude uses `messages` and `max_tokens`, not `input` or `text.format`.
- Claude's JSON mode is different (can use `response_format: {type: 'json_object'}` via the Messages API, but the API shape is distinct).
- Claude returns `content: [{type: 'text', text: '...'}]` in the Messages API.
- You would need a `callClaude` function, a new response extraction path, and potentially different prompt packaging because Claude's system prompt handling differs.

**The real problem:** `buildAgentPrompt` hardcodes the OpenAI-style `input` array. Even though `callOllama` adapts this to `messages`, the prompt builder is not provider-agnostic. It assumes a multi-turn conversation with a system message followed by user messages. Not all providers treat system/user roles the same way.

**What is genuinely reusable:**
- The timeout wrapper (`callModelProviderWithRunTimeout`) is generic.
- The abort/signal handling is generic.
- The request/response snapshot recording is generic.
- The `modelRequestCount` budget enforcement is generic.

**What is not reusable:**
- Prompt construction.
- Response parsing.
- JSON extraction.
- Usage normalization.

### Honest Assessment

Could another provider be added? **Yes, but it requires writing a new function and touching runtime semantics.** The `callModelProvider` switch is not an abstraction — it is a dispatch table. There is no `ModelProvider` interface. There is no adapter contract. There is no normalization layer.

Is this bad? **Not yet.** The system only supports two providers, and both are chat-completion-like. Adding a third would be straightforward code. But if you ever need to support:
- A provider that streams responses
- A provider that requires tool-use instead of chat completion
- A provider with different authentication models
- A provider that returns structured output differently

...you will be editing the runtime loop, not adding an adapter.

**Recommendation:** Do not abstract this yet. The current approach is honest. A bad abstraction (fake `ModelProvider` interface with methods that don't generalize) would be worse than the switch. If a third provider arrives, *then* extract an interface based on the commonalities that actually exist.

---

## 2. Workspace Boundary

### Current State

`createLocalWorkspaceProvider(root)` returns an object with:
- `exists`, `getPathInfo`, `list`, `readFile`, `writeFile`, `createFile`, `createFolder`, `rename`, `delete`

The action vocabulary (`AGENT_ALLOWED_OPERATIONS`) maps 1:1 to these methods.

### Verdict: Swappable Implementation, Non-Swappable Semantics

**What is swappable:**
The provider closure pattern is actually good. You could write:
- `createS3WorkspaceProvider(bucket)`
- `createGitWorkspaceProvider(repoPath)`
- `createGoogleDriveWorkspaceProvider(folderId)`

...and as long as they expose the same methods, the runtime would call them.

**What is NOT swappable:**
- **The action vocabulary itself.** `listDirectory`, `readFile`, `createFolder`, `writeFile`, `renamePath`, `deletePath` are filesystem verbs. If your workspace is a CRM, what is `createFolder`? What is `readFile`? The vocabulary assumes a hierarchical file system.
- **Prompt text.** `buildAgentPrompt` teaches the model: "You may request workspace CRUD actions... listDirectory, readFile, createFolder..." The model cannot interact with a CRM using these verbs. You would need to rewrite the entire prompt.
- **Recovery logic.** Recovery is deeply filesystem-specific:
  - `writeFile` recovery means "restore previous content" or "delete created file"
  - `renamePath` recovery means "rename back"
  - `deletePath` is marked unrecoverable because "deleted content not stored"
  - Pre-state capture reads file contents into memory for rollback
  - If workspace is object storage, recovery semantics change entirely (versioned buckets vs non-versioned)
- **Postcondition completion.** The heuristic checks for `already_exists_noop`, `already_missing_noop`, and compares file content hashes. These are filesystem concepts.
- **Ownership model.** `ownedOutputPaths` assumes hierarchical containment (`path.startsWith(ownedPath)`). This maps poorly to graph databases, CRM objects, or document systems with non-hierarchical IDs.
- **Protected paths.** `DEFAULT_PROTECTED_WORKSPACE_PATHS` includes `.git`, `.env`, `node_modules`, `package.json`. These are application-filesystem specific.
- **Fixture system.** Workspace fixtures create folders and files. A CRM workspace would need entirely different fixtures.

**What would break if workspace became a CRM:**
1. `listDirectory` → meaningless. CRMs have queries, not directory listings.
2. `createFolder` → meaningless. CRMs have records, cases, contacts — not folders.
3. `writeFile` → partially meaningful as "create/update record", but `content` is a string, not structured data.
4. `renamePath` → meaningless.
5. `deletePath` → meaningful as "delete record", but path-based deletion is wrong.
6. The prompt would teach the model to use filesystem operations on CRM data.
7. Recovery would try to restore "file contents" for CRM records.
8. Ownership paths would try to restrict CRM record creation to subdirectories.

**The deeper issue:** The runtime doesn't just use a filesystem provider. It *encodes filesystem semantics* in:
- Action vocabulary
- Prompt instructions
- Recovery logic
- Postcondition checks
- Ownership enforcement
- Protected paths
- Fixture system
- Operation history shapes (preState captures `contentHash`, `type: 'file'`)

**Honest Assessment:**

You can swap the **implementation** of the filesystem (local disk → networked FS → FUSE) without touching runtime semantics. But you cannot swap the **domain** (files → CRM records → legal documents → database rows) without rewriting significant parts of the runtime.

The workspace provider is a **false boundary**. It looks like an abstraction because it's a closure with methods, but the runtime above it assumes those methods mean filesystem things.

---

## 3. Action System

### Current State

- `AGENT_ALLOWED_OPERATIONS` = hardcoded array
- `AGENT_MUTATING_OPERATIONS` = hardcoded subset
- `AGENT_OPERATION_ARGS` = hardcoded arg schemas
- `AGENT_PRIMITIVE_METADATA` = hardcoded shapes + authority + provenance
- `GENERATED_AGENT_ACTIONS` = dynamically maps the above into catalog entries
- `ACTIONS_CATALOG` = generated + hand-authored operator/system actions

Runtime dispatch in `executeWorkspaceOperation` is a giant `if/else if` chain on `operation === 'listDirectory'` etc.

### Verdict: Good Dynamic Generation, Bad Runtime Dispatch

**What works:**
- The catalog generation is honest. It derives from the source-of-truth arrays. Adding a new primitive operation requires adding it to `AGENT_ALLOWED_OPERATIONS`, `AGENT_OPERATION_ARGS`, and `AGENT_PRIMITIVE_METADATA` — the catalog updates automatically.
- The catalog's shape descriptions (strings like `'string'`, `'number'`) are used only for documentation (actions catalog page, EJS rendering). They are not runtime type validators. This is correct — runtime validation is explicit in `executeWorkspaceOperation`.

**What doesn't work:**
- **No plugin model.** You cannot add a new workspace primitive without editing `executeWorkspaceOperation`'s giant switch statement.
- **Authority is strings, not code.** `authorityConstraints` in the catalog is a human-readable string. The actual authority enforcement is scattered:
  - `assertAgentWorkspacePathAllowed` for sensitive paths
  - `blockProtectedWorkspaceOperation` for protected paths
  - `assertAllocatedOwnershipAllowsMutation` for owned paths
  - These are hardcoded checks, not derived from the catalog.
- **Operator actions are duplicated.** There are separate catalog entries for `operatorWorkspaceCreateFile`, `operatorWorkspaceCreateFolder`, etc., but these aren't used for dispatch — they're just documentation. The actual operator workspace routes are separate Fastify handlers.
- **Action results are domain-coupled.** `actionResults` fed back to the model includes `{action, result}` or `{action, error}`. The `result` objects are filesystem-specific shapes. A CRM action system would need different result shapes.

**Catalog vs Runtime divergence:**
The catalog says `writeFile` response shape is `{path: 'string', size: 'number'}`. But the actual runtime returns `{path: resolved.relativePath}` (no size). The catalog is documentation, not contract enforcement. This is fine for now, but it means the catalog cannot be used for runtime validation.

**Honest Assessment:**

The action catalog is a **documentation generator**, not a runtime system. The runtime is a hardcoded switch. This is acceptable for a bounded application, but it is not extensible.

If you wanted to support a new action (e.g., `searchFiles`, `appendToFile`), you would touch:
1. `AGENT_ALLOWED_OPERATIONS`
2. `AGENT_OPERATION_ARGS`
3. `AGENT_PRIMITIVE_METADATA`
4. `executeWorkspaceOperation` (new if-branch)
5. `buildAgentPrompt` (teach model about new action)
6. Potentially recovery logic
7. Potentially postcondition logic

That is 7+ touch points. Not modular.

---

## 4. Runtime Core

### Current State

The runtime core is `runAgentTicket`, which orchestrates:
1. Provider call with timeout
2. Response parsing (`parseModelActions`)
3. Action validation (limits, malformed checks)
4. Action execution loop
5. Budget enforcement (steps, operations, requests, time)
6. Stall detection (empty actions, repeated lists)
7. Replay snapshot recording
8. Postcondition completion check
9. Finalization (completed/failed/interrupted)

### Verdict: Mostly Generic, Coupled at the Seams

**What is genuinely reusable substrate:**

1. **Bounded execution loop.** The `for (let step = 0; !completed; step += 1)` pattern with `assertRunStepAllowed`, `assertRunModelRequestAllowed`, `assertRunWorkspaceOperationAllowed`, `assertRunNotTimedOut` is **pure substrate**. It enforces budgets independent of what actions mean.

2. **Replay/provenance system.** Recording `providerRequests`, `modelResponses`, `parsedModelPlans`, `workspaceOperations`, `events` into a replay snapshot is **pure substrate**. It doesn't care what the operations are. It records what happened.

3. **Stall detection.** Detecting `complete:false` with empty actions, or repeated `listDirectory` without mutations, is **substrate-level behavior**. It catches model failure modes generically.

4. **Action limit enforcement.** `actions.length > MAX_AGENT_ACTIONS_PER_RESPONSE` and `mutatingActionCount > MAX_MUTATING_ACTIONS_PER_RESPONSE` are generic bounds.

5. **Interruption/finalization.** The `completeAgentRun` / `failAgentRun` / `interruptAgentRun` flow, replay snapshot finalization, and ticket status updates are **governance substrate** — reusable for any bounded agent execution.

**What is coupled to the application:**

1. **Response parsing.** `parseModelActions` expects `{"message", "actions": [{"operation", "args"}], "complete"}`. This shape is hardcoded. If you wanted a model to return a plan instead of actions, you'd rewrite this.

2. **Prompt construction.** `buildAgentPrompt` is the single biggest coupling point. It:
   - Hardcodes the workspace action vocabulary
   - Hardcodes the JSON response format
   - Hardcodes step budget reasoning instructions
   - Hardcodes mutating action limits
   - Hardcodes ownership path instructions
   - Hardcodes allocation subtask instructions
   This is ~30 lines of prompt text that cannot generalize to another domain.

3. **Action execution feedback.** `actionResults` is fed back into the next prompt as `previousActionResults`. The model is expected to understand `{action, result}` and `{action, error}` shapes. These shapes are filesystem-specific.

4. **Postcondition completion.** As implemented, it checks filesystem-specific no-op statuses. The *idea* of postcondition completion is generic ("if all proposed mutations are no-ops, we're done"), but the *implementation* is filesystem-specific.

5. **Replay snapshot base.** `createReplaySnapshotBase` includes:
   - `primitiveContract.allowedOperations` — references hardcoded arrays
   - `workspaceRoot` — filesystem-specific
   - `ownedOutputPaths` — assumes path hierarchy
   - `allocationSubtask` — ticket-system specific

**What is substrate vs app:**

| Component | Substrate? | Notes |
|---|---|---|
| Budget enforcement (steps/ops/requests/time) | **Yes** | Pure counter logic |
| Timeout/signal handling | **Yes** | Generic abort controller pattern |
| Replay snapshot recording | **Yes** | Event append is generic |
| Replay snapshot finalization | **Yes** | Status + failure metadata |
| Stall/no-progress detection | **Yes** | Generic behavioral patterns |
| Provider call orchestration | **Partial** | Generic timeout, but provider-specific request/response |
| Model response parsing | **No** | Hardcoded JSON shape |
| Prompt construction | **No** | Domain vocabulary hardcoded |
| Action execution loop | **Partial** | Generic iteration, but action dispatch is hardcoded |
| Postcondition completion | **Partial** | Generic idea, filesystem implementation |
| Recovery | **No** | Deeply filesystem-specific |
| Operation history | **Partial** | Generic record structure, but pre/post state shapes are filesystem-specific |

**Honest Assessment:**

The runtime core has a **genuine substrate layer** hidden inside it. The budget enforcement, replay recording, and stall detection are reusable. But they are not **extracted** — they are interleaved with application-specific prompt construction, action dispatch, and filesystem recovery.

If you wanted to reuse this runtime for:
- A code-generation agent (instead of filesystem, it modifies ASTs)
- A database-migration agent (instead of files, it runs SQL migrations)
- A test-generation agent (instead of files, it manipulates test suites)

You would need to extract:
1. The budget loop (steps, ops, requests, time)
2. The replay recording system
3. The finalization/interruption system

And then rewrite:
1. Prompt construction
2. Action dispatch
3. Result feedback
4. Postcondition checks
5. Recovery logic

The substrate is **real but not extracted**.

---

## 5. UI / Operational Surfaces

### Current State

EJS templates for:
- Tickets list, ticket detail
- Logs list, log filtering
- Runs detail
- Admin dashboard, user/group/agent management
- Actions catalog (documentation)
- Login

JavaScript: minimal client-side (status dropdowns, SSE log streaming)

### Verdict: Deeply Application-Specific, But Honestly So

**What the UI assumes:**
- Tickets exist, have statuses, have assignment targets
- Runs exist, have outcomes, have replay snapshots
- Workspace operations are filesystem actions
- Agents have providers and models
- Groups have permissions
- Operation history has recovery status

**What is generic enough:**
- The **log streaming** surface (`/api/logs/events`) is generic event streaming.
- The **SSE connection** setup is reusable.
- The **pagination** pattern is generic.
- The **actions catalog** page is a documentation renderer that could display any catalog.

**What is not generic:**
- Ticket cards show `lastRunOperationalOutcome`, `lastRunPartialMutationCount`, assignment modes (`allocated`, `dynamic`). These are domain-specific.
- Run detail pages show `Workspace Operations`, `Provider Requests`, `Model Responses`. These names assume the current agent loop.
- The admin dashboard is specific to users/agents/groups/permissions.
- Log filtering by `runId` and `ticketId` assumes those entities exist.

**Honest Assessment:**

The UI is **honestly application-specific**. It does not pretend to be a generic operational dashboard. The EJS templates embed domain logic directly (`lastRunHadPartialMutations`, `assignmentMode === 'allocated'`). This is correct for a single application.

The operational visibility model (logs, replay, history) *could* generalize, but it is currently named and shaped for this domain. Extracting it would require:
- Genericizing log types (currently `workspace:write`, `model:request`, `run:completed`)
- Genericizing replay snapshot keys (currently `workspaceOperations`, `providerRequests`)
- Genericizing history shapes (currently `operation`, `args`, `preState`, `postState`)

This is possible but not done.

---

## 6. Extensibility Pressure

### Where Pressure Will Appear First

1. **Provider adapter interface.** When a third provider arrives (Claude, Gemini, local LLM via different API), the `callModelProvider` switch will become unmaintainable. The prompt builder will need branching. **Pressure: HIGH.**

2. **Workspace domain abstraction.** If the system ever needs to support non-filesystem workspaces (database migrations, CRM updates, API orchestration), the entire action vocabulary, prompt text, recovery logic, and postcondition checks need rewriting. **Pressure: HIGH.**

3. **Action dispatch plugin model.** Adding new workspace primitives currently requires 7+ touch points. If the system needs `appendToFile`, `copyPath`, `searchContent`, the switch statement in `executeWorkspaceOperation` will become unwieldy. **Pressure: MEDIUM.**

4. **Prompt template system.** As prompt engineering becomes more sophisticated (different prompts per provider, per model, per task type), hardcoding prompt text in `buildAgentPrompt` will become a maintenance burden. **Pressure: MEDIUM.**

5. **Recovery generalization.** Recovery is currently filesystem-only. If operations become non-filesystem, recovery logic needs abstraction. **Pressure: MEDIUM (conditional on domain change).**

### What Should Remain Monolithic

- **The runtime loop.** Do not split `runAgentTicket` into micro-functions or plugin hooks. The loop's integrity depends on shared state (step counters, action results, budget checks). Breaking it up prematurely would introduce race conditions and hidden coupling.
- **Replay snapshot structure.** The snapshot schema is a contract. Changing it requires migrating all existing snapshots. Keep it monolithic and versioned.
- **Budget enforcement.** Step limits, operation limits, request limits, and time limits must be enforced in one place to prevent drift.

### What Should Eventually Become Adapters/Interfaces

- **Provider adapter.** Extract when a third provider arrives. Interface: `callModel(input, signal) → {text, usage, providerResponsePayload}`.
- **Workspace provider.** Already partially there (`createLocalWorkspaceProvider`), but the *action vocabulary* needs abstraction too. Interface should be at the action level, not just the filesystem level.
- **Prompt builder.** When prompt engineering becomes complex enough, extract a `PromptBuilder` that knows how to serialize the action vocabulary and runtime envelope for a given provider.
- **Recovery strategy.** When non-filesystem recovery is needed, extract `RecoveryStrategy` per operation type.

### What Should NOT Be Abstracted Yet

- **Do not create a generic `ActionExecutor` plugin system.** The current switch is readable and debuggable. A plugin system would add indirection without benefit.
- **Do not create a `WorkspaceAdapter` interface with 20 methods.** The current closure provider is fine. The problem is the vocabulary, not the implementation.
- **Do not create a policy DSL.** The permission system (users/groups/permissions) is simple RBAC. A DSL would be overkill.
- **Do not extract the runtime into a npm package.** The replay schema, budget semantics, and prompt contracts are not stable enough to be a library.

---

## 7. Architectural Risk

### Fake Extensibility

- **`callModelProvider` looks like an abstraction, but it is a switch statement.** Adding a provider requires editing the function, not implementing an interface.
- **`createLocalWorkspaceProvider` looks like a swappable adapter, but the runtime assumes filesystem semantics.** You can swap local disk for S3, but not files for CRM records.
- **`ACTIONS_CATALOG` looks like a runtime action system, but it is documentation.** The runtime does not use it for dispatch or validation.

### Premature Abstraction

- The system has **avoided** premature abstraction well. There is no plugin system, no adapter framework, no generic executor. Everything is honest about what it is.
- The one near-exception: `extractOpenAIText` is named like a generic text extractor but only handles OpenAI formats. This is minor.

### Hidden Coupling

1. **`buildAgentPrompt` is the God coupling point.** It knows about:
   - Workspace actions
   - Provider response format
   - Budget semantics
   - Ownership paths
   - Allocation plans
   - Ticket objectives
   If you change any of these, you may need to rewrite the prompt.

2. **`actionResults` feedback loop couples model prompting to action execution.** The prompt includes `previousActionResults` which has filesystem-specific result shapes. If you change what `writeFile` returns, you change what the model sees.

3. **`runAgentTicket` couples provider calls to workspace execution to replay recording.** These are not separable without careful refactoring.

### Portability Illusions

- **"We can swap the workspace provider"** — True for implementation (local → S3), false for domain (files → CRM).
- **"We can add new providers"** — True if they are chat-completion-like, false if they require different interaction patterns.
- **"The replay system is portable"** — Partially true. The recording mechanism is portable, but the recorded data shapes are domain-specific.

### Maintainability Traps

1. **`server.js` is 6400+ lines.** This is a maintenance trap. Not because monolithic files are inherently bad, but because the runtime substrate is mixed with:
   - HTTP route handlers
   - EJS view data builders
   - Auth logic
   - Workspace provider implementation
   - Provider API clients
   - Recovery logic
   - Operation history normalization
   - Ticket/run lifecycle management

   Finding where a bug lives requires understanding all of these.

2. **The prompt is a single 30-line string literal.** Prompt engineering changes require editing server source code and redeploying. There is no prompt versioning, no A/B framework, no prompt template system.

3. **Environment variable defaults are scattered.** `AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE`, `AGENT_MAX_EXECUTION_STEPS`, etc. are read from env in one place but used in many. There is no centralized configuration object.

4. **Test fixtures assume filesystem state.** `WORKSPACE_FIXTURES` creates files and folders. Tests that verify workspace behavior depend on filesystem side effects. Moving to a different workspace implementation would require rewriting all tests.

### Runtime Assumptions That Will Break First

1. **Model returns valid JSON.** The system assumes the model can reliably return parseable JSON with the exact required shape. With less capable models (or models that refuse), `parseModelActions` will fail. The `model:malformed` handling is good, but the system has no graceful degradation for partial JSON.

2. **Provider API stability.** OpenAI's Responses API is new. If OpenAI changes the response format, `extractOpenAIText` breaks. The system has no provider API version negotiation.

3. **Filesystem is the workspace.** The most brittle assumption. If the application domain shifts even slightly (e.g., from file creation to database row creation), large parts of the runtime need rewriting.

4. **Operator understands replay snapshots.** The replay system is comprehensive, but it assumes operators will read JSON files or use `oquery`. There is no visual replay playback, no diff viewer, no workspace state comparison tool.

5. **Step limit is the primary bound.** The system assumes models will exhaust step limits before operation limits or request limits. If a model issues many small operations per step, the operation limit may hit first, producing a different failure mode.

---

## Final Verdict

### Is this a solid operational substrate or a filesystem/ticket app with governance layers?

**It is a filesystem/ticket app with strong governance layers.**

The governance layers (bounded execution, replay, provenance, mutation accounting, interruption/recovery) have **substrate-quality design**. They are honest, bounded, evidence-driven, and operator-visible. The DIRECTION.md principles are sound and are actually followed in the code.

But these layers are **not extracted**. They are welded to:
- Filesystem action vocabulary
- OpenAI/Ollama chat completion APIs
- Ticket/run/agent domain models
- EJS view assumptions

### What would make it a substrate?

Extracting the following as independent modules with clear interfaces:

1. **`BoundedExecutionLoop`** — budget enforcement, stall detection, finalization. Takes a `step()` callback. Knows nothing about prompts or actions.
2. **`ReplayRecorder`** — append-only event recording with schema versioning. Knows nothing about what events mean.
3. **`ProviderAdapter`** — `callModel(input, config) → {text, usage, rawResponse}`. Normalizes across providers.
4. **`ActionDispatcher`** — maps action names to executors. Executor returns `{result, error}`. Prompt builder is separate.
5. **`PromptBuilder`** — given an action vocabulary and runtime envelope, produces provider-specific input.

### Should you do this now?

**No.** The current system is honest, functional, and maintainable at its current scale. Extracting substrate would introduce abstraction overhead without clear operational benefit. The DIRECTION.md principle applies: *"Semantic density emerges from operational pressure, not from architectural design."*

When operational pressure demands a third provider, a non-filesystem workspace, or a new action primitive, **then** extract the substrate based on the patterns that have proven necessary.

Until then, the system is correctly architected: **a well-governed application with substrate-like qualities, not a generic substrate pretending to be an application.**
