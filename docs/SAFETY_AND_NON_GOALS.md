# Safety and Non-Goals

## 1. Safety model

The system is safe because it is **bounded by construction**: every unit of work is a visible ticket
that executes as a run, under explicit authority, with all external effects flowing through the
target provider and producing durable evidence. Layers added on top (Work Context, handoff, watcher,
model routing, connector, operational summary) are **grouping, visibility, proposal, or
dispatch-record** surfaces — none of them is a new way to execute, mutate, or bypass authority. Human
judgment stop points (triage) catch ambiguity and denial instead of guessing.

## 2. Explicit non-goals

- No real external connectors; no OAuth/API-key integrations.
- No Slack/Discord/Gmail/Google Drive integration; no notification integration.
- No background watcher daemon; no automatic polling.
- No model-provider API expansion beyond existing agent provider/model config.
- No workflow builder; no rich UI; no autonomous child-ticket spawning.
- Not production-security-hardened, not multi-tenant/hosted, not a correctness guarantee for
  arbitrary tasks.

## 3. No hidden work

Every ticket and run is visible. No surface (handoff, watcher, connector, routing, ops) creates work
off-ledger. Tests assert "no hidden work / no new ledger / no ticket-or-run created by side
surfaces" across the substrate.

## 4. No private agent-to-agent channel

Agent-to-agent handoff happens only by creating a **normal ticket** that the recipient claims
normally. There is no direct private channel and no bypass of ticket permissions or Work Context
scope.

## 5. No authority bypass

Permissions to *use* a surface never imply authority to mutate a target. Mutation requires run-level
authority through the target provider. Model routing grants no authority; connector availability is
not write authority; watcher proposals do not execute.

## 6. No connector credential storage

Connectors hold a `credentialRef` only — never a plaintext secret. Any `credential`/`secret`/`apiKey`
/`token`/`password` field is rejected. Connector writes are refused entirely in this release.

## 7. No real external connectors yet

The only connector kind is `local_mock`, a contract fixture reading a local object store. Real
external connectors are deferred behind their own design audit
(`docs/CONNECTOR_BOUNDARY_DESIGN_AUDIT.md`).

## 8. No watcher daemon yet

Watchers are **manual** — they observe only when an operator triggers an observe. There is no
background daemon and no automatic polling. Future bounded sync is deferred
(`docs/BOUNDED_WATCHER_DESIGN_AUDIT.md`).

## 9. Demo fixtures are not product data

All seed/demo fixtures (demo seed data, local connector objects, example agents) are **test/demo
only**. Real businesses will connect their **own** drives/data later. The local/mock connector is a
contract fixture, not a real external connector.

## 10. Human judgment stop points

Work **stops safely** rather than guessing at: triage; authority denial; no model route; connector
refusal; watcher refusal/failure; verification failure; ambiguous objective; and unresolved
process-template version consistency. Each records evidence and waits for a human where judgment is
needed.

## 11. What the verified baseline means

The deterministic release checkpoint tests the current bounded runtime baseline. A passing
checkpoint is not a production-readiness or semantic-correctness claim. Current guarantees,
product direction, and known work live in `docs/SYSTEM_STATUS.md`; historical results remain in Git
history or explicitly historical release documents.

## 12. What a v1.0 tag will mean

A future `v1.0` tag will mean the release documentation is complete and the maintainers have made
an explicit decision that the bounded substrate, its safety boundaries, its scale path, and its
known limitations are accurately documented and acceptable for the intended use. It will **not** by
itself imply capabilities that have not been separately designed, implemented, and audited.
