# Model / Provider Routing Design Audit

## 1. Executive summary

The substrate now has explicit tickets, runs, Work Contexts, a handoff protocol, watcher proposals,
receipts, and smoke tests. The guiding principle was never "one model to rule them all" — it was
that **different agents/models/tools may be better for different work, but the queue substrate must
carry the work, sources, limits, receipts, and stop points.**

**Recommendation:** model/provider routing should exist, but only as **run dispatch policy** inside
the existing ticket/run substrate — not a new orchestration layer. Concretely, routing:

- **must not replace** Ticket, Run, Authority, Target Provider, Evidence, Verification, Triage,
  Timeline, Work Context, Handoff, or Watcher;
- **must be auditable** and **snapshotted per run** (immutable once the run starts);
- **must not silently change old tickets/runs** (legacy runs stay unrouted; no backfill);
- **must not create hidden work**, **must not bypass authority**, and **must not bypass
  verification/triage**.

Routing chooses *which execution backend reasons/acts* for a run; everything else — the ticket, the
run lifecycle, authority, target mutations, evidence, verification, and triage — stays exactly where
it is. Today an agent already carries `provider`/`model` and runs capture `providerRequests` /
`modelResponses` in replay evidence; routing formalizes the **selection** of that backend and
records the decision on the run.

## 2. Current substrate map

Routing must respect every primitive and own none of them.

| Primitive | Home / doc | Routing constraint |
| --------- | ---------- | ------------------ |
| **Ticket** | `data/tickets.json` | Routing never replaces work intent; it decides a run's backend. |
| **Run** | `data/runs.json` | The execution unit; routing writes a snapshot onto it, nothing more. |
| **Agent / Group assignment** | ticket `assignmentTarget*` | Routing selects a provider/model for execution; it does not reassign the ticket. |
| **Authority** | permissions + delegated per-run authority | Routing never grants capability; the provider cannot exceed ticket authority. |
| **Target Provider** | `docs/TARGET_PROVIDER_CONTRACT.md` | Separate boundary — *where* mutations/reads happen, distinct from *who reasons*. |
| **Evidence / Event / Receipt** | `events.jsonl`, `operation-history.json`, replay snapshots | The route decision becomes evidence; provider output is not a receipt by itself. |
| **Verification** | verification contracts | Unchanged; routing never decides "done". |
| **Triage** | ticket/run triage | The stop point for no-route / unsafe-route / budget-exceeded. |
| **Timeline** | r1.18 projection | Projection-only; the routing snapshot is supporting metadata, not a new ledger. |
| **Work Context** | `data/work-contexts.json` | May set/restrict routing policy; never widens authority. |
| **Handoff protocol** | r1.23 | Handoff tickets may carry routing hints; recipient still claims normally. |
| **Bounded watcher proposals** | r1.26 | A proposal may hint at routing; routing happens only at run dispatch after approval. |
| **Process Template** | `data/process-templates.json` | Unchanged; templates create tickets, routing decides their runs' backends. |
| **Schedule** | template `schedule` object | Unchanged; no scheduled-token change. |

## 3. Problem model/provider routing solves

- **Different providers/models may be better for different work** (capability fit, cost, latency,
  risk, tool/target needs).
- Users should **not manually copy work** between agents/tools to use a different backend.
- Routing should **choose an execution backend while preserving the same ticket/run/evidence path**.
- Routing should support **capability fit, risk, cost, latency, target/tool needs, and Work Context
  policy**.
- Routing should make the **provider choice visible and auditable** (recorded on the run).

## 4. What model/provider routing is

- a **dispatch-time policy** evaluated when a run is planned;
- **capability-to-provider matching** (capabilityId → eligible providers/models);
- a **model/provider selection snapshot** written to the run;
- a **fallback / refusal policy** (explicit, recorded);
- a **cost / latency / risk policy** (bounded, auditable);
- an **audit / evidence surface** (the route decision is evidence);
- **not execution itself** — the selected provider runs through the existing runtime path.

## 5. What model/provider routing is not

- **not a new agent system** and **not a hidden orchestration layer**;
- **not a provider connector implementation**;
- **not a memory system**; **not a watcher**; **not a scheduler**; **not a workflow builder**;
- **not a private agent-to-agent channel**;
- **not a way to bypass tickets/runs**;
- **not a way to bypass authority or verification**.

## 6. Proposed routing policy object shape

Conceptual only (not code):

```
ModelRoutingPolicy {
  id
  name
  status                  // active | paused | archived
  workContextId           // optional scope; a policy may be Work-Context-scoped
  capabilityId            // the capability this policy routes
  allowedProviders        // allow-list of provider ids
  preferredProvider
  preferredModel
  fallbackProviders       // ordered, explicit fallbacks (opt-in)
  maxCost
  maxLatency
  riskClass
  toolRequirements        // tools the provider must support
  targetRequirements      // target-provider needs (separate boundary)
  verificationRequirement // routing never weakens verification
  triageOnNoRoute         // when no provider is eligible → triage/refuse
  createdAt
  updatedAt
}
```

## 7. Proposed run routing snapshot

Every run should eventually snapshot the route decision — **immutable once the run starts**, so
history is interpreted as it was decided:

```
run.routingSnapshot = {
  policyId
  selectedProvider
  selectedModel
  reason
  capabilityId
  workContextId
  fallbackUsed
  rejectedProviders
  constraints
  decidedAt
}
```

`routingSnapshot` is **nullable** — legacy/unrouted runs simply omit it.

## 8. Routing inputs

**Allowed inputs:** ticket objective; `capabilityId` / `workflowId`; assignment target; Work
Context policy; target/provider requirements; allowed tools/operations; risk class; verification
requirement; triage requirement; explicit user/admin constraints; provider availability;
cost/latency budget.

**Disallowed inputs:** hidden memory; private chat history; unrelated Work Context state; stale
provider assumptions without evidence.

## 9. Routing decision lifecycle

```
ticket created
  → run planned
  → routing policy evaluated
  → provider/model selected
  → routing snapshot written to the run (immutable from run start)
  → provider executes through the existing runtime path
  → evidence/receipts produced
  → verification/triage handles the result
```

## 10. Fallback and refusal behavior

- **No eligible provider** → triage/refuse, never guess.
- **Provider unavailable** → fallback **only if explicitly allowed**; the fallback is **recorded**.
- **Unsupported tool/target request** → authority denial or triage.
- **Cost/risk budget exceeded** → triage/refuse.
- **Verification failure** → the normal verification/triage path (routing changes nothing here).
- **No automatic provider hopping mid-run** unless explicitly designed later.

## 11. Authority relationship

- Routing **never grants capability**.
- The **selected provider cannot exceed ticket authority**.
- Provider/tool choice **cannot widen target access**.
- **Authority decisions remain evidence.**
- An **authority denial is not "solved" by switching providers** unless explicitly permitted and safe.

## 12. Work Context relationship

- A Work Context **may set a default routing policy** and **restrict providers/models**.
- A Work Context **cannot silently widen authority**.
- **Changing a Work Context's routing later does not reinterpret old runs** (runs snapshot the
  decision at dispatch).
- An **archived Work Context cannot create new routed work**.

## 13. Handoff relationship

- Handoff-created tickets **may carry routing hints**.
- The **recipient still claims normally** (r1.23).
- Routing **does not create a private agent-to-agent channel**.
- Handoff **source/evidence refs remain independent of provider choice**.

## 14. Watcher relationship

- Watcher proposals **may include routing hints**.
- A watcher **cannot directly run a model**.
- An **approved proposal creates a normal ticket**, and routing happens at **run dispatch**.
- A watcher **cannot wake agents or providers directly**.

## 15. Target Provider relationship

- **Model/provider routing is separate from target-provider routing.**
- The **model provider decides who reasons/acts**; the **target provider controls where
  mutations/read operations happen**.
- Routing **cannot bypass target-provider receipts**.
- **Target and provider names must not be confused** in UI/docs (e.g. "agent / provider / model"
  vs "target").

## 16. Timeline and evidence relationship

- The routing decision should be **visible in the timeline** once implemented.
- The timeline **remains projection-only**.
- The **routing snapshot is evidence/supporting metadata, not a new ledger**.
- **Logs are not canonical.**
- **Provider outputs are not receipts** unless linked to run evidence / target receipts.

## 17. Privacy / data boundary

- Provider selection **must respect data sensitivity**.
- Provider restrictions **may be per Work Context**.
- Routing should **avoid sending sensitive source material to disallowed providers**.
- The route decision should **record why a provider was allowed**.
- **No provider can read unrelated Work Context data.**

## 18. UI implications

Future UI should show: the **selected provider/model on run detail**; the **routing reason**;
**fallback used or not**; **provider restrictions from Work Context**; and **routing failures as
triage**. **No giant provider config UI** in the first implementation.

## 19. Migration strategy

- **Old runs remain unrouted/legacy**; **no backfill**.
- `routingSnapshot` is **nullable**; **policies are optional at first**.
- **Existing provider/model config remains supported** (agents still carry provider/model).
- **No historical reinterpretation.**

## 20. Recommended r1.28 implementation slice

`r1.28-model-provider-routing-implementation` — the **smallest** slice:

- add a **routing policy data store**;
- add a **`routingSnapshot` to new runs only**;
- support **one default routing policy and one explicit override path**;
- expose **read-only routing info on run/timeline**;
- **no external provider integration changes**;
- **no model API changes** unless already abstracted;
- **no hidden work**, **no provider hopping**, **no connector changes**, **no watcher execution**,
  **no authority widening**.

## 21. Recommended tests for r1.28

- routing policy CRUD creates **no ticket/run/workspace mutation**;
- a **new run gets a `routingSnapshot`**;
- **old runs render without** a `routingSnapshot`;
- **provider restriction is enforced**;
- **fallback only when allowed** (and recorded);
- **no eligible provider causes triage/refusal**;
- routing **does not widen authority**;
- routing **does not change target-provider behavior**;
- routing **does not change scheduler tokens**;
- **Work Context routing restriction applies at creation/dispatch time**;
- **watcher proposal approval still creates a normal ticket before routing**;
- **handoff-created ticket still routes normally**;
- **timeline can show the routing decision without a new ledger**;
- **no old tickets/runs/evidence rewritten**.

## 22. Risks

**P0**

- routing becomes **hidden orchestration**;
- a **provider switch bypasses authority**;
- **sensitive Work Context data goes to a disallowed provider**;
- routing **creates hidden runs**;
- **fallback hides failures** instead of triaging;
- **target-provider and model-provider boundaries get confused**.

**P1**

- the routing policy surface becomes **too complex**;
- **stale provider metadata** leads to bad decisions;
- **fallback behavior creates inconsistent evidence**;
- **cost/latency controls become unverifiable**;
- **provider-specific capabilities leak** into generic ticket semantics.

**P2**

- **legacy runs lack a `routingSnapshot`**;
- **UI naming confusion**: agent, provider, model, target, worker;
- **too much routing** before a real provider abstraction is needed.

## 23. Final recommendation

- **Proceed to r1.28 only as routing policy + snapshot.**
- **Preserve the ticket/run execution model.**
- **Keep provider choice auditable.**
- **Keep Work Context as the policy boundary.**
- **Keep Authority as the permission boundary.**
- **Keep Target Provider as the mutation boundary.**
- **Keep Triage as the stop point** for no-route / unsafe-route.
- **Defer** advanced provider integrations, connector changes, cost telemetry, and model evaluation.
