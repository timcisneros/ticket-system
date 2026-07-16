# Operator Guide

How to operate the bounded ticket/run substrate. For precise term definitions see
`docs/PRIMITIVE_GLOSSARY.md`; for first-run mechanics see `docs/SETUP_AND_FIRST_RUN.md`.

## 1. Purpose

This guide is for an operator running the system locally: how to create and inspect work, where
evidence lives, where work stops for human judgment, and the safe operating rules that keep the
substrate bounded.

## 2. First run

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run dev       # http://localhost:3099, ignored .local-data / .local-workspace
```

For local demo/development, log in as the bootstrap admin (`admin` / `admin123`, or
`ADMIN_BOOTSTRAP_PASSWORD`). For a no-provider-key tour of the full loop, use
`npm run demo:seed && npm run demo:dev`.

## 3. Accounts and permissions

Authority is permission-based. Relevant permissions include `ticket:create/read/update/delete`,
`workspace:read/write/reset`, `processTemplate:manage`, `workContext:manage`, `watcher:manage`,
`modelRouting:manage`, `connector:manage/read/write`, and `ops:read`. A permission lets you *use* a
surface; it does **not** grant authority to mutate a target — that still flows through a run under
delegated authority.

## 4. Tickets and runs

A **ticket** is the durable work object (objective, assignment, policy, status, provenance). A
**run** is the only execution unit; it claims a lease, executes, and produces evidence. Inspect
tickets at `/tickets` and `/tickets/:id`, runs at `/runs/:id`. Create tickets in the UI or with the
`oquery` CLI.

## 5. Workspace / Target Provider boundary

All external effects (file reads/writes in the workspace) go through the **target provider**
contract — the single mutation boundary. The workspace target is `WORKSPACE_ROOT`. See
`docs/TARGET_PROVIDER_CONTRACT.md`.

## 6. Authority and receipts

Every mutation requires authority and produces a **receipt** in `operation-history.json` plus
events. Authority decisions (allowed/denied) are recorded as evidence. Receipts derive from durable
evidence, **not** agent self-report. See `docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH_AUDIT.md`.

## 7. Verification and triage

When a ticket declares postconditions, **verification** judges "done". **Triage** is the human stop
point for blocked/failed/ambiguous work — review it at `/triage`. Resolving triage **annotates**
(who/when/why); it never reruns, completes, or changes status.

## 8. Timeline

`/api/tickets/:id/timeline` and the ticket-detail Timeline section show a **read-only, deterministic
projection** over events/evidence — including claim, work-receipt, handoff, and routing entries. The
timeline owns no state and creates no ledger.

## 9. Process templates and schedules

`/process-templates` manages reusable ticket starters. A **schedule** creates one ordinary ticket per
interval (UTC, no catch-up, version-free token `schedule:<id>:<iso>`). Activation is append-only and
reconciled at startup (`docs/PROCESS_TEMPLATE_ACTIVATION_DURABILITY.md`). Schedules create tickets,
never run work.

## 10. Work Contexts

`/work-contexts` groups related tickets/templates and supplies creation-time defaults + listing
filters. A Work Context **never executes** and **never widens authority**; archived contexts block
new assignments. See `docs/WORK_CONTEXT_PRIMITIVE.md` / `docs/WORK_CONTEXT_VISIBILITY_SURFACE.md`.

## 11. Handoff queue protocol

Move work between humans/agents as **normal tickets**. `POST /api/tickets/:id/handoff` (needs
`ticket:create`) creates an ordinary ticket carrying a self-contained handoff receipt (sources,
constraints, stop condition, receipt expectation). The recipient **claims normally**; there is no
private channel. Claim/work receipts are derivable at `/api/runs/:id/claim-receipt` and
`/api/runs/:id/work-receipt`. See `docs/AGENT_HANDOFF_QUEUE_PROTOCOL.md`.

## 12. Watchers

`/watchers` manages **manual** observer/proposers scoped to a Work Context. `observe` reads one
bounded source and writes a receipt (metadata/hash, no content). A watcher may draft a **proposal**;
a proposal is not execution — approval creates a normal ticket via `ticket:create`. No background
daemon, no automatic polling. See `docs/BOUNDED_WATCHER.md`.

## 13. Model / provider routing

`/model-routing-policies` manages dispatch policies. Each new run records an immutable
`routingSnapshot` (selected provider/model, reason, fallback, rejected providers). Routing **never
changes which provider executes** (the agent's own provider/model) and **never grants authority**; a
policy that permits no provider refuses into triage. See `docs/MODEL_PROVIDER_ROUTING.md`.

## 14. Local connector contract

`/connectors` manages the **local/mock** connector only. `connector:read` reads a bounded object
(returns content in the response, persists a metadata/hash receipt). **Writes are refused** in this
release — connector availability is not write authority. Credentials are a `credentialRef`, never a
value. See `docs/LOCAL_CONNECTOR_CONTRACT.md`.

## 15. Operational transparency

`/ops` and `GET /api/ops/summary` (need `ops:read`) show a **read-only** health snapshot: counts,
warning flags, recent failures/refusals, event-journal capacity/pressure, and links to the relevant
pages. `GET /api/runtime/status` and `oquery runtime-status` expose the same live journal pressure
for runtime diagnostics. Reading these surfaces writes nothing and creates no summary ledger. See
`docs/OPERATIONAL_TRANSPARENCY.md`.

## 16. Release checkpoint

`npm run checkpoint:release` is the release gate (currently 54/54). See `docs/RELEASE_CHECKPOINT.md`
for the full hygiene flow (clean tree → expected branch/files → build → checkpoint → ff-merge →
annotated tag).

## 17. Troubleshooting

- **Run failed: "Agent API key is missing"** — configure a provider/model on the agent (Admin or
  env). Tracked seed agents carry no keys.
- **Local model timeout** — small local models may be slow or not follow the protocol; a timeout is
  not by itself a bad mutation or false completion.
- **`data/events.jsonl` missing after a pull** — expected (it became untracked); the app recreates an
  empty one. Restore old contents deliberately if needed (see README).
- **No-route triage** — a routing policy permitted no provider; edit the policy or reassign.
- **Connector read refused** — the object is out of `sourceRoots`, cross-context, or the connector/
  context is inactive; the receipt records the reason.

## 18. Safe operating rules

- **Inspect before changing.**
- **Do not treat logs as a canonical source of truth** — evidence (events/operation-history/replay)
  is canonical; logs are diagnostic.
- **Do not bypass tickets/runs** — all work is a ticket that runs.
- **Do not mutate targets without authority** — mutation flows through the target provider under
  run authority.
- **Do not treat watcher proposals as execution** — a proposal becomes work only via `ticket:create`.
- **Do not treat connector availability as write authority** — connector writes are refused.
- **Do not delete backup branches without an explicit owner decision** — they are preserved and out
  of the release flow.
