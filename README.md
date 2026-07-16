# Ticket System

## 1. Project summary

A **bounded ticket/run substrate**. You create a **ticket** (a durable work object), it runs as
a **run** under explicit **authority**, all external effects flow through a **target provider**, and
everything produces **evidence/receipts**. On top of that substrate sit grouping, visibility,
handoff, observation, and routing layers — all bounded and read-only or proposal-only.

The current repository baseline is an **internal development/demo implementation**. It is not a
production-readiness claim. The product direction is scalable hosted deployment of the bounded
ticket/run substrate; today's single-process Fastify server and JSON files are an engineering stage,
not the product's scale ceiling. See `docs/SYSTEM_STATUS.md` for current guarantees, product
direction, and known work. Historical release audits remain snapshots rather than current
verification authority.

## 2. What this system is

- A **ticket → run → authority → target provider → evidence** execution model.
- A **human-control surface**: tickets, runs, verification, triage, timeline, and an operational
  summary make work inspectable.
- A set of **bounded primitives** layered above the runtime: process templates & schedules, Work
  Contexts, a handoff queue protocol, a bounded watcher, model/provider routing, a local/mock
  connector contract, and operational transparency.

## 3. What the current baseline is not

- **Not a fully autonomous agent platform.** Every unit of work is a visible ticket; nothing
  executes off-ledger.
- **Not** production-security-hardened, multi-tenant/hosted, or a correctness guarantee for arbitrary
  tasks.
- **No** real external connectors, OAuth/API-key integrations, Slack/Discord/Gmail/Google Drive, no
  background watcher daemon, no automatic polling, no private agent-to-agent channel, no workflow
  builder, no rich UI.

## 4. Core primitives

Ticket · Run · Authority · Target Provider · Evidence/Receipt · Verification · Triage · Timeline ·
Process Template · Schedule · Work Context · Handoff · Watcher · Model Routing · Connector ·
Operational Summary. See **`docs/PRIMITIVE_GLOSSARY.md`** for precise definitions and commonly
confused terms.

## 5. Current implementation scope

Ticket creation/assignment; runs with lease/claim, attempts, evaluation; workspace/target operations
through the bounded target-provider contract; authority & permissions; append-only evidence &
receipts; verification & triage; per-ticket timeline projection; process templates & schedules;
process-template activation durability reconciliation; Work Context grouping & visibility; the
handoff queue protocol (claim/work/handoff receipts) with a deterministic smoke loop; a bounded
manual watcher (observer/proposer); model/provider routing (dispatch policy + immutable per-run
snapshot); a local/mock connector contract (bounded read with receipt, write refused); a read-only
operational transparency surface; restart-safe event integrity checks; fail-closed startup data
validation; and a hardened release checkpoint. The current status and remaining work are in
`docs/SYSTEM_STATUS.md`. A tested PostgreSQL persistence/coordination foundation is present, but the
server has not yet crossed that authority boundary; see `docs/POSTGRES_CUTOVER.md`.

## 6. Quick start

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run dev       # serves on http://localhost:3099 against ignored .local-data / .local-workspace
```

Login with the bootstrap admin (created only when missing): `admin` / `admin123` (override with
`ADMIN_BOOTSTRAP_PASSWORD` before first start; never reuse it beyond local demo/dev).

Guided, **no-provider-key** demo of the full loop:

```sh
pnpm run demo:seed  # writes git-ignored .local-demo-data / .local-demo-workspace
pnpm run demo:dev   # serves the app against the demo fixture
```

See **`docs/SETUP_AND_FIRST_RUN.md`** for a full first-run walkthrough and `docs/DEMO_WALKTHROUGH.md`
for the click path. Configuration variables are documented under **Configuration** below.

## 7. Run the release checkpoint

The release checkpoint is the **release gate** — provider-free, network-free, deterministic, and
temp-`DATA_DIR`/`WORKSPACE_ROOT` safe:

```sh
pnpm run checkpoint:release
```

It runs a project-wide JavaScript syntax build plus the ordered `CHECKPOINT_TEST_SCRIPTS`, fails
loudly if any referenced script is missing, and reports the executed and passing check count. See
**`docs/RELEASE_CHECKPOINT.md`** for what a pass does and does not mean and the full release-hygiene
flow.

## 8. Demo fixtures note

All seed/demo fixtures (`scripts/seed-demo-data.js`, the local/mock connector objects, tracked
example agents) are **test/demo only — not final product seed data**. Real businesses will connect
their **own** drives/data later. The current **local/mock connector is a contract fixture, not a real
external connector**, and it refuses writes. Tracked seed agents carry **no provider API keys**.

## 9. Current limitations

- No real external connector yet (only the `local_mock` contract).
- Current run records must retain their immutable run-start evidence. Startup rejects missing or
  invalid run-limit snapshots before recovery can begin. Reset or regenerate development run data
  after a run-schema change when that specific compatibility path has no product value. Other record
  types retain compatibility behavior where current code and tests require it; future hosted-data
  migrations should be decided from retained user data and storage architecture.
- Activation writes the version store then the root in two atomic writes; a crash between them is
  reconciled at startup (`docs/PROCESS_TEMPLATE_ACTIVATION_DURABILITY.md`) but is not fully
  transactional.
- No production deployment baseline. Sessions are in memory, persistence is multi-file JSON, and
  hosted/multi-tenant isolation is not implemented. PostgreSQL schema and concurrency primitives are
  under test, but the server deliberately refuses a partial PostgreSQL mode until the complete
  authority cutover is ready.
- Arbitrary acceptance criteria are supplied to agents but are not automatically proven; fixture
  verifier contracts are offline benchmark metadata unless expressed as runtime postconditions.
- The model contract compiler and prefix truncation are default-off experiments; dependent
  mutation graphs remain unvalidated for truncation.
- Naming care: *Model Provider* (who reasons) ≠ *Target Provider* (where mutations happen); see the
  glossary.

### Event log lifecycle

`events.jsonl` is append-only and has no automatic size cap, rotation, compaction, or retention
policy. Process-local append and run admission are bounded and observable, but those controls do
not bound file growth. Startup validates the journal as a stream; scoped historical queries remain
bounded-memory, synchronous O(file bytes) scans until an indexed shared store replaces JSONL.
Inspect or deliberately archive a local/development log with
`node scripts/archive-local-events.js`; use `--archive --reset` only when an archived copy should be
followed by a fresh empty log. Horizontal deployment will require shared durable storage and an
explicit retention/archival design.

The indexed shared-storage replacement is active engineering work rather than a deferred product
possibility. Its implemented boundary, verification, and remaining cutover steps live in
`docs/POSTGRES_CUTOVER.md`.

## 10. Documentation map

**Start here:** this README → `docs/SETUP_AND_FIRST_RUN.md` → `docs/OPERATOR_GUIDE.md` →
`docs/PRIMITIVE_GLOSSARY.md`.

- **Status / safety:** `docs/SYSTEM_STATUS.md`, `docs/RELEASE_CHECKPOINT.md`,
  `docs/SAFETY_AND_NON_GOALS.md`, `docs/POSTGRES_CUTOVER.md`, `docs/INDEX.md`.
- **Historical release records:** `docs/RELEASE_CANDIDATE_AUDIT.md`,
  `docs/RELEASE_NOTES_r1.33.md`.
- **Primitive docs:** `docs/TARGET_PROVIDER_CONTRACT.md`,
  `docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md`,
  `docs/TICKET_TIMELINE_AND_AUTHORITY_VISIBILITY.md`,
  `docs/PROCESS_TEMPLATE_ACTIVATION_DURABILITY.md`, `docs/WORK_CONTEXT_PRIMITIVE.md`,
  `docs/WORK_CONTEXT_VISIBILITY_SURFACE.md`, `docs/AGENT_HANDOFF_QUEUE_PROTOCOL.md`,
  `docs/HANDOFF_SMOKE_TESTS_AND_DEMO_SCENARIOS.md`, `docs/BOUNDED_WATCHER.md`,
  `docs/MODEL_PROVIDER_ROUTING.md`, `docs/LOCAL_CONNECTOR_CONTRACT.md`,
  `docs/OPERATIONAL_TRANSPARENCY.md`.
- **Design audits:** `docs/CONNECTOR_BOUNDARY_DESIGN_AUDIT.md`,
  `docs/MODEL_PROVIDER_ROUTING_DESIGN_AUDIT.md`, `docs/BOUNDED_WATCHER_DESIGN_AUDIT.md`,
  `docs/WORK_CONTEXT_PRIMITIVE_DESIGN_AUDIT.md`.
- **Configuration / data model / CLI detail:** `docs/SETUP_AND_FIRST_RUN.md` (env vars, ports,
  first run) and `docs/OPERATOR_GUIDE.md` (data/evidence model, headless `oquery` CLI). The deeper
  semantics & operations canon live in `AGENTS.md`, `OPERATIONS.md`, the rest of `docs/`
  (`ARCHITECTURE_INVARIANTS.md`, `EXECUTION_MODEL.md`, `LIFECYCLE_EVENTS.md`, `FAILURE_TAXONOMY.md`,
  `KNOWN_LIMITATIONS.md`, …), and `scripts/README.md`.

> **Backup branches.** A prior reconciliation preserved three branches holding foreign concurrent
> work and the original bad-stack commit: `backup/local-master-with-foreign-and-r1.28`,
> `backup/foreign-stack-before-r1.28`, `backup/r1.28-commit-caec9a6`. They are **intentionally
> preserved and excluded from the release flow — do not merge, push, delete, or move them without an
> explicit owner decision** (see `docs/RELEASE_CHECKPOINT.md`).
