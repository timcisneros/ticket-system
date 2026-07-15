# Primitive Glossary

Precise definitions for the bounded ticket/run substrate. See `docs/OPERATOR_GUIDE.md` for usage.

## Terms

- **Ticket** — the durable work object (objective, assignment, policy, status, provenance,
  ticket-level triage). Not a prompt and not execution. Store: `data/tickets.json`.
- **Run** — the only execution unit for a ticket: lease/claim, attempts, verification snapshot,
  evaluation, run-level triage. Store: `data/runs.json`.
- **Agent** — a configured worker identity (provider + model + credentials) a ticket can be assigned
  to. Tracked seed agents carry no provider keys.
- **Group** — a set of principals; a ticket-capable group can receive tickets (allocated/dynamic).
- **Authority** — what an actor/run may do (permission catalog + per-run delegated authority). The
  permission boundary; never widened by layers above the runtime.
- **Target Provider** — the single contract through which external mutations/reads happen (the
  workspace target). The mutation boundary. See `docs/TARGET_PROVIDER_CONTRACT.md`.
- **Workspace** — the file target a run mutates, rooted at `WORKSPACE_ROOT`, reached only through the
  target provider.
- **Evidence** — durable, append-only proof of what happened: `events.jsonl`,
  `operation-history.json`, replay snapshots, run evaluation/consequence. Canonical.
- **Receipt** — a structured record of an action derived from evidence (operation receipt, claim
  receipt, work receipt, handoff receipt, connector receipt). Not agent self-report.
- **Verification** — independent judgment that a declared objective's postconditions passed.
- **Triage** — the human stop point for blocked/failed/ambiguous work; resolution annotates only.
- **Timeline** — a read-only, deterministic projection over a ticket's events/evidence. Owns no
  state; creates no ledger.
- **Process Template** — a reusable ticket starter (manual + scheduled). Store:
  `data/process-templates.json`; append-only versions in `data/process-template-versions.json`.
- **Schedule** — a template's interval/UTC ticket-creation config; token
  `schedule:<templateId>:<scheduledForIso>` (version-free); no catch-up. Creates tickets, never runs.
- **Work Context** — a product-layer grouping above the runtime: groups tickets/templates, supplies
  creation-time defaults, and scopes listings. Never executes; never widens authority. Store:
  `data/work-contexts.json`.
- **Handoff** — moving work as a normal ticket with a self-contained brief + receipt; recipient
  claims normally. No private channel.
- **Watcher** — a manual, Work-Context-scoped observer/proposer. Observes one bounded source with a
  receipt; may draft proposals; never mutates/wakes/runs. Store: `data/watchers.json`.
- **Model Provider** — the backend that *reasons/acts* for a run (e.g. an agent's OpenAI/Ollama
  provider+model). Distinct from the target provider.
- **Model Routing Policy** — a dispatch-time rule selecting which provider/model a run is recorded as
  using. Store: `data/model-routing-policies.json`.
- **Routing Snapshot** — the immutable per-run record of the routing decision (`run.routingSnapshot`:
  policyId, selectedProvider/Model, reason, fallbackUsed, rejectedProviders). Supporting metadata,
  not a new ledger.
- **Connector** — a bounded source/target adapter scoped to a Work Context. r1.30 ships only a
  `local_mock` kind (bounded read with receipt; write refused). Store: `data/connectors.json`.
- **Connector Receipt** — a metadata/hash receipt for each connector read/refused-write; never full
  content. Store: `data/connector-receipts.json`.
- **Local Mock Connector** — the only connector kind today: reads a local fixture object store
  (`data/local-connector-objects.json`). A contract fixture, not a real external connector.
- **Operational Summary** — a read-only health snapshot derived live from existing stores (`/ops`,
  `/api/ops/summary`). Writes nothing; no store.
- **Release Checkpoint** — the release gate: `npm run checkpoint:release` runs `node --check` plus
  the ordered test list (currently 50/50), provider-free and network-free. See
  `docs/RELEASE_CHECKPOINT.md`.

## Commonly confused terms

- **Model Provider vs Target Provider** — the *model provider* decides **who reasons/acts**; the
  *target provider* controls **where mutations/reads happen**. Separate boundaries.
- **Connector vs Target Provider** — a *connector* is a (currently local/mock) source adapter; the
  *target provider* is the canonical mutation boundary. Connector reads/writes flow through provider
  contracts where possible and never replace operation receipts.
- **Watcher vs Scheduler** — a *watcher* is a manual observer/proposer with its own (manual) cadence;
  the *process-template scheduler* creates tickets on a fixed interval. Neither executes work.
- **Watcher Proposal vs Ticket** — a *proposal* is a draft; it is not a ticket and not execution.
  Approval creates a normal ticket via `ticket:create`.
- **Timeline vs Ledger** — the *timeline* is a read-only projection that owns no state; the *ledgers*
  (events, operation-history, trigger ledger) are the durable stores it projects from.
- **Log vs Evidence** — *logs* (`data/logs.json`) are diagnostic/narrative; *evidence*
  (events/operation-history/replay) is canonical. Logs are never the source of truth.
- **Work Context vs Execution Boundary** — a *Work Context* is a grouping/scope label; the
  *execution boundary* is the run + authority + target provider. Grouping never executes.
