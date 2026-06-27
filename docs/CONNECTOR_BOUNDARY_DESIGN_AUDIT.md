# Connector Boundary Design Audit

## 1. Executive summary

Businesses will eventually connect their own drives/data; the current workspace fixtures are only
**test/demo substitutes**. Before adding any real connector, the connector boundary must be defined
so external systems do not become **hidden authority, hidden memory, hidden execution, or hidden
source-of-truth**.

**Recommendation:** connectors should exist, but only as **bounded source/target adapters**.
Concretely, a connector:

- **must not become an execution engine** — execution stays Ticket → Run → Authority → Target
  Provider → Evidence;
- **must not bypass** the Target Provider, Authority, Evidence, Work Context, Watcher, Handoff,
  Model Routing, Verification, or Triage;
- every connector **read/write produces a receipt**;
- connector **credentials are scoped and auditable** (a reference, never plaintext in tracked data);
- connector data is **tied to Work Context and Target Provider boundaries**.

No connector code ships in r1.29 — this is design only.

## 2. Current substrate map

A connector must respect every primitive and own none of them.

| Primitive | Home / doc | Connector constraint |
| --------- | ---------- | -------------------- |
| **Target Provider** | `docs/TARGET_PROVIDER_CONTRACT.md` | The mutation boundary; connector reads/writes flow through it where possible. |
| **Ticket** | `data/tickets.json` | Work intent; a connector never creates work on its own. |
| **Run** | `data/runs.json` | The only execution unit; a connector is not a run and creates none. |
| **Authority** | permissions + delegated per-run authority | Connector permission is **not** ticket authority; writes require explicit authority. |
| **Evidence / Event / Receipt** | `events.jsonl`, `operation-history.json`, replay snapshots | Every connector action produces a receipt; logs are not canonical. |
| **Work Context** | `data/work-contexts.json` | The scope boundary; connector data cannot leak across contexts. |
| **Watcher** | `data/watchers.json` (r1.26) | Watchers may *observe* connector-backed sources later; they never mutate through a connector. |
| **Handoff** | r1.23 | Handoff still moves work as tickets; connectors don't open private channels. |
| **Model Routing** | r1.28 | Chooses the reasoning backend; it cannot grant connector access. |
| **Timeline** | r1.18 projection | Connector receipts project in read-only; no connector timeline ledger. |
| **Verification / Triage** | contracts + triage | Connector failures become evidence/triage, not hidden retries. |
| **Process Templates / Schedules** | template stores | Unchanged; a connector is not a scheduler. |

## 3. Problem connectors solve

- Businesses need their **own real data sources** — drives, datasets, systems of record.
- The **current fixtures are demo/test only** and are not product data.
- Connectors let the system **observe/read/write external systems through bounded contracts**.
- Connectors **reduce copy/paste** between systems **without creating hidden autonomy**.

## 4. What a connector is

- an **external-system adapter**;
- a **source reader** (bounded scopes/roots);
- an **optional target mutator** *only if authorized*;
- a **credential boundary** (holds a credential reference, scoped);
- a **receipt producer** (every action recorded);
- a **Target Provider implementation detail or input** — connector reads/writes flow through the
  target-provider contract where possible;
- a **Work-Context-scoped integration**.

## 5. What a connector is not

- **not an agent**; **not a scheduler**; **not a watcher**; **not model routing**;
- **not a memory system**;
- **not a hidden execution path**;
- **not a bypass around the Target Provider** or **around Authority**;
- **not a source of truth without receipts**;
- **not a place to store unbounded chat/history**.

## 6. Connector object shape

Conceptual only (not code):

```
Connector {
  id
  name
  status            // active | paused | archived
  kind              // e.g. local_mock | workspace | (future external kinds)
  workContextId     // one Work Context, or an explicit global admin scope
  credentialRef     // a reference to a secret store — never the secret itself
  allowedScopes     // least-privilege scope grants
  sourceRoots       // bounded read roots
  targetRoots       // bounded write roots (writes require authority)
  readPolicy
  writePolicy
  receiptPolicy
  syncPolicy        // r1.29: manual only; no background sync
  createdAt
  updatedAt
}
```

## 7. Credential and scope boundary

- Credentials are **never stored in plaintext tracked data** — the connector holds a
  **`credentialRef`** only.
- **Least privilege**: `allowedScopes` are explicit and minimal.
- **Per Work Context scoping**: credentials are scoped to the connector's Work Context.
- **Revocation**: revoking a credential disables the connector's reads/writes; in-flight actions
  refuse and record evidence.
- **No credential sharing across unrelated contexts.**
- **Connector permission is separate from ticket authority.**
- **Connector availability does not imply mutation permission** — a reachable connector still needs
  explicit write authority to write.

## 8. Target Provider relationship

- Connector reads/writes should **flow through Target Provider contracts** where possible.
- The **Target Provider remains the mutation boundary**.
- **Operation receipts remain canonical for writes**; connector-specific metadata can **enrich** a
  receipt but **cannot replace** it.
- **Connector failures become evidence/triage**, never hidden retries.

## 9. Watcher relationship

- Watchers **may observe connector-backed sources** in the future.
- Watcher observe **remains bounded** (one source, manual, receipt-recorded).
- A watcher **cannot mutate through a connector**.
- Watcher **proposals still require approval** before becoming tickets.
- **No watcher daemon** in this milestone.

## 10. Model Routing relationship

- **Model/provider routing chooses the reasoning backend**; the **connector chooses the data/system
  boundary** — distinct concerns.
- **Routing cannot grant connector access.**
- **Connector sensitivity may constrain routing policy** (e.g. a sensitive connector may restrict
  which providers may run on its data).
- A **provider cannot read connector data unless policy allows it**.

## 11. Work Context relationship

- **Every connector belongs to one Work Context** (or an explicit global admin scope).
- **Connector data cannot leak across contexts.**
- An **archived Work Context disables connector use by default**.
- **Context changes do not reinterpret old connector receipts** (receipts snapshot their context).

## 12. Authority relationship

- **Connector permission is not ticket authority.**
- A **ticket must still carry allowed operations**.
- **Writes require explicit authority**; **reads require an explicit read scope**.
- **Authority denial is recorded** as evidence.
- **No connector action happens because a model asks for it** unless authority permits it.

## 13. Evidence and receipt relationship

Every connector action records a receipt:

```
ConnectorReceipt {
  connectorId
  workContextId
  operation              // read | write | list | ...
  sourceRef / targetRef
  externalObjectId
  timestamp
  actorId / runId / ticketId
  requestMetadata        // bounded — no secrets
  resultMetadata         // bounded — counts/ids/status
  checksum / hash / version   // if available
  error / refusal             // if any
}
```

**No full sensitive content** in receipts unless explicitly safe and bounded.

## 14. Timeline relationship

- Connector receipts **can appear in the timeline as projections**.
- **No connector timeline ledger** is created.
- **Logs are not canonical.**
- **Source precedence remains unchanged.**

## 15. Sync / cadence relationship

- **No background sync in r1.29.**
- Future sync must be **explicit, bounded, and watcher-like**.
- **No catch-up storms**; **no sub-minute polling**.
- **Sync never executes work directly** — it only produces observation/receipt/proposal/triage
  evidence.

## 16. Failure / refusal behavior

Each of these refuses/triages safely and records evidence — never guesses:

- **auth failure**; **permission denied**; **source unavailable**; **rate limit**; **object changed
  externally**; **conflict**; **unknown object**; **partial write**; **stale receipt**; **ambiguous
  mapping**.

## 17. Migration strategy

- **No fixture replacement yet**; **no old data rewrite**.
- **Connectors are optional**; absence is valid.
- **Existing workspace fixtures remain demo/test only.**
- **Future businesses connect their own drives/data.**
- **Connector records start empty.**

## 18. Recommended r1.30 implementation slice

`r1.30-first-local-connector-or-connector-contract-implementation` — the **smallest** safe slice:

- a **connector registry/store**;
- **one local/mock connector only**, or **connector contract tests only**;
- **no external OAuth yet**; **no Google/Slack/Gmail yet**;
- a **connector receipt shape**;
- **connector permission checks**;
- **target-provider integration if safe**;
- **no background sync**; **no hidden work**.

## 19. Recommended tests for r1.30

- connector CRUD creates **no ticket/run/workspace mutation**;
- connector `credentialRef` **never exposes a secret**;
- a connector **read produces a receipt**;
- a connector **write requires authority**;
- a connector **failure records evidence/refusal**;
- a connector **cannot cross Work Context**;
- a **watcher cannot mutate through a connector**;
- **model routing cannot grant connector access**;
- the **timeline can show a connector receipt without a new ledger**;
- **no scheduler-token changes**; **no hidden run**; **no old evidence rewritten**.

## 20. Risks

**P0**

- connector **bypasses authority**;
- **credential leak**;
- **cross-context data leak**;
- connector becomes a **hidden scheduler/executor**;
- **external write without a receipt**;
- **model provider gets sensitive connector data improperly**.

**P1**

- connector **retries create duplicate writes**;
- **stale external object state**;
- **rate limits break determinism**;
- **fixture/demo data confused with product data**;
- **connector errors hidden as generic failures**.

**P2**

- **too much connector UI too early**;
- **naming confusion between target provider and connector**;
- **the mock connector does not represent real external systems enough**.

## 21. Final recommendation

- **Proceed only with a connector contract / local mock next.**
- **Do not add real external connectors yet.**
- **Preserve the Target Provider as the mutation boundary.**
- **Preserve Work Context as the scope boundary.**
- **Preserve Authority as the permission boundary.**
- **Preserve the Watcher as observer/proposer.**
- **Preserve Model Routing as the reasoning-backend policy.**
- **Require a receipt for every connector action.**
