# Safety and Non-Goals

## 1. Safety model

The system is safe because it is **bounded by construction**: every unit of work is a visible ticket
that executes as a run, under explicit authority, with all external effects flowing through the
target provider and producing durable evidence. Layers added on top (Work Context, handoff, watcher,
model routing, connector, operational summary) are **grouping, visibility, proposal, or
dispatch-record** surfaces — none of them is a new way to execute, mutate, or bypass authority. Human
judgment stop points (triage) catch ambiguity and denial instead of guessing.

## 2. Current implementation boundaries

These are boundaries of the current internal development/demo baseline, not permanent prohibitions
on the product roadmap. Scalable hosted deployment remains the direction described in
`SYSTEM_STATUS.md`; any new capability still requires its own design, authority, evidence, and
verification work.

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
/`token`/`password` field is rejected. Connector writes are refused in the current baseline.

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

## 12. Release labels and future version decisions

Version and release-readiness criteria are maintainer decisions based on the intended users,
capabilities, operating environment, and evidence available at that time. This document does not
predefine a documentation-only `v1.0`, and it does not turn current implementation boundaries into
permanent product limits. Any readiness claim must identify the tested baseline and the capabilities
that were actually designed, implemented, and verified.
