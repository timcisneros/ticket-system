# Release Candidate Audit

> Historical snapshot: this document records the r1.32/43-check audit. For current implementation
> status, see `SYSTEM_STATUS.md`. This snapshot is not updated with later results.

## 1. Executive summary

The substrate is internally coherent, bounded, and test-covered. **Verdict: ready for release
documentation** — no P0 or P1 blockers were found in this audit.

This is **not** a final v1.0 tag. The remaining work is **release documentation and the final tag
procedure** (recommended as `r1.34-release-documentation`). The current system is a **bounded
ticket/run substrate** with grouping, visibility, handoff, observation, and routing layers on top —
**not an autonomous agent platform**. Every unit of work is a visible ticket that runs through a
single execution path; no layer added since r1.18 introduces a new way to execute, mutate, or
bypass authority.

## 2. Current release state

- **Current master:** `32e7a6b` (after r1.32).
- **Latest shipped tag:** `r1.32-release-checkpoint-hardening`.
- **Release checkpoint:** `43/43` checks, provider-free and network-free.
- **Backup branches preserved and OUT of the release flow:**
  `backup/local-master-with-foreign-and-r1.28`, `backup/foreign-stack-before-r1.28`,
  `backup/r1.28-commit-caec9a6`.
- **No foreign backup commits shipped:** the two foreign concurrent commits (`96223b7`, `db35df5`)
  and the original bad-stack commit (`caec9a6`) are **not** ancestors of `master`; the shipped r1.28
  commit is the clean cherry-pick `8c00524`.

## 3. Product scope at release candidate

The system currently supports:

- **Ticket creation and assignment** (agent or ticket-capable group; objective + policy).
- **Runs** — the single execution unit, with lease/claim, attempts, evaluation, and triage.
- **Workspace/target operations** through the bounded **Target Provider** contract.
- **Authority and permissions** — per-run delegated authority and a permission catalog.
- **Evidence and receipts** — append-only events, operation-history, replay snapshots.
- **Verification and triage** — postcondition contracts; human stop point.
- **Timeline visibility** — read-only projection per ticket.
- **Process templates and schedules** — reusable ticket starters; interval/UTC schedules.
- **Process-template activation durability** — startup reconciler for root/version-store mismatch.
- **Work Contexts** — product-layer grouping + read-only visibility surface.
- **Handoff protocol** — claim/work/handoff receipts; agent-to-agent via normal tickets.
- **Bounded watcher** — manual observer/proposer.
- **Model/provider routing** — dispatch policy + immutable per-run routing snapshot.
- **Local/mock connector contract** — bounded read with receipt; write refused.
- **Operational transparency** — read-only `/ops` summary.
- **Hardened release checkpoint** — coverage guard + existence pre-check.

## 4. Non-goals and explicit limits

- **No real external connectors yet** — only a `local_mock` connector contract.
- **No OAuth/API keys**; **no Slack/Discord/Gmail/Google Drive** integration.
- **No background watcher daemon**; **no automatic polling**.
- **No model-provider API expansion** beyond the existing agent provider/model config.
- **No hidden autonomous work**; **no private agent-to-agent channel**.
- **No workflow builder**; **no rich UI**.
- **No production customer-data assumptions** — **demo fixtures are test/demo only**.

## 5. Primitive integrity audit

| Primitive | Role | Boundary |
| --------- | ---- | -------- |
| **Ticket** | Durable work intent (objective, assignment, policy, status, provenance, triage). | Not a prompt; not execution. |
| **Run** | The only execution unit (attempts, lease, verification snapshot, evaluation, triage). | Nothing executes without a run. |
| **Authority** | What an actor/run may do (permissions + per-run delegated authority). | Never widened by any layer above. |
| **Target Provider** | The single mutation/read boundary for the workspace target. | The only path to external effect. |
| **Evidence/Receipt** | Append-only events, operation-history receipts, replay snapshots. | Canonical proof, not self-report. |
| **Verification** | Postcondition judgment of "done". | Independent; never weakened. |
| **Triage** | Human stop point for blocked/failed/ambiguous work. | Annotates; never auto-executes. |
| **Timeline** | Read-only chronological projection per ticket. | Owns no state; projection only. |
| **Process Template** | Reusable ticket starter (manual + scheduled). | Creates ordinary tickets only. |
| **Schedule** | Interval/UTC ticket creation (`schedule:<id>:<iso>`, version-free, no catch-up). | Creates tickets, never runs work. |
| **Work Context** | Product-layer grouping + defaults + filters. | Never executes; never widens authority. |
| **Handoff** | Move work as a normal ticket with a self-contained brief + receipt. | No private channel; recipient claims normally. |
| **Watcher** | Manual, scoped observer/proposer. | Never mutates/wakes/runs; proposals need approval. |
| **Model Routing** | Per-run dispatch policy + immutable snapshot. | Records choice; never changes execution or grants authority. |
| **Connector** | Bounded local/mock source adapter. | Reads with receipts; writes refused; no external system. |
| **Operational Summary** | Read-only derived health snapshot. | Writes nothing; no new source of truth. |

## 6. Source-of-truth audit

| Concern | Canonical store |
| ------- | --------------- |
| tickets | `data/tickets.json` |
| runs | `data/runs.json` |
| events/evidence | `data/events.jsonl` |
| operation history | `data/operation-history.json` |
| process templates | `data/process-templates.json` |
| process-template versions | `data/process-template-versions.json` |
| template trigger ledger | `data/process-template-triggers.json` |
| Work Contexts | `data/work-contexts.json` |
| watchers | `data/watchers.json` |
| watcher observations | `data/watcher-observations.json` |
| watcher proposals | `data/watcher-ticket-proposals.json` |
| model routing policies | `data/model-routing-policies.json` |
| connector records | `data/connectors.json` |
| connector receipts | `data/connector-receipts.json` |
| local connector mock objects | `data/local-connector-objects.json` |
| operational summary | **derived live — no store** |

Confirmed: the **timeline is projection-only**; the **operational summary is projection-only**;
**logs (`data/logs.json`) are diagnostic/narrative, not canonical source of truth**; and **connector
receipts are metadata/hash receipts, not full-content storage**.

## 7. Authority and permission audit

Permissions reviewed: `ticket:create/read/update/delete`; `workspace:read/write/reset` and
`workspace.delete.cross_ticket_artifact`; `processTemplate:manage`; `workContext:manage`;
`watcher:manage`; `modelRouting:manage`; `connector:manage/read/write`; `ops:read`.

Confirmed:

- **Permissions do not imply authority to mutate targets** — target mutation still flows through the
  Target Provider under per-run delegated authority.
- **Connector permission does not bypass ticket authority** — connector writes are refused entirely
  in r1.30, and connector availability is never write authority.
- **Model routing does not grant authority** — it records a dispatch decision; a disallowed provider
  refuses into triage rather than widening anything.
- **Watcher observe/proposal does not execute work** — a proposal becomes a ticket only via
  `ticket:create`, then runs normally.

## 8. Execution path audit

Confirmed the **only** execution path is **Ticket → Run → Authority → Target Provider → Evidence**:

- **Handoffs create normal tickets** (via `createTicketFromInput`); the recipient claims normally.
- **Watcher proposal approval creates a normal ticket** (`ticket:create`); the proposal itself runs
  nothing.
- **Model routing only snapshots the dispatch decision** on the run; it does not re-point execution.
- **Connector reads/writes create no runs** (writes are refused).
- **Process-template triggers create ordinary tickets** through the normal path.
- **No hidden execution path exists** — every smoke/contract test asserts "no hidden work / no new
  ledger / no ticket-or-run created by side surfaces."

## 9. Stop-point audit

Each of these **stops safely rather than guessing**:

- **Triage** — blocked/failed/ambiguous work halts for human judgment; resolution annotates only.
- **Authority denial** — recorded as evidence; not retried silently.
- **No model route** — refuses into triage (`authority_blocked` vocabulary + routing-specific
  evidence ref); no run created.
- **Connector refusal** — out-of-bounds/cross-context/inactive reads record a `read_refused` receipt;
  writes record `write_refused`.
- **Watcher refusal/failure** — archived/paused/inactive or missing-source observations record
  `refused`/`failed` receipts; no guessing.
- **Verification failure** — the normal verification/triage path.
- **Ambiguous objective** — blocked with `objective_ambiguous`; no run, no folder guessing.
- **Process-template durability unresolved** — the r1.12.2 reconciler refuses ambiguous repairs and
  logs `version_consistency_unresolved` for manual review.

## 10. Receipt / evidence audit

Reviewed: target operation receipts (operation-history); run evidence (events + replay snapshot +
evaluation); claim receipt (on `run.lease_acquired`); work receipt (derived); handoff receipt (on
ticket `source`); watcher observation receipt; watcher proposal provenance (`watcher_proposal`
source + timeline entry); connector receipt; routing snapshot; timeline projection.

Confirmed:

- **Receipts do not depend on agent self-report alone** — they derive from durable events,
  operation-history, replay snapshots, and run evaluation.
- **Receipts avoid full sensitive content** — work receipts and connector receipts carry
  counts/ids/paths/hashes, never file contents or provider bodies (asserted by tests).
- **Provider bodies are not promoted to canonical receipts** — they live in replay evidence, linked
  through run evidence, not surfaced as receipts.

## 11. Work movement audit

Reviewed: ticket assignment; run claim (lease); work receipt; triage / needs-input; handoff-created
ticket; watcher proposal; approval into a ticket; Work Context visibility.

Confirmed the queue principle holds: **work can leave chat, carry its sources/limits/stop-condition,
stop for human judgment, and return with a receipt** — entirely through visible tickets, with no
private channel and no hidden work. The r1.24 handoff smoke loop demonstrates the full chain
end-to-end, provider-free.

## 12. Test coverage audit

- **Release checkpoint:** `43/43` (1 `node --check` + 42 test scripts), provider-free,
  network-free, temp-`DATA_DIR`/`WORKSPACE_ROOT`, deterministic.
- **Coverage guard** (`release-checkpoint-coverage-test.js`) asserts the list is honest (exists / no
  duplicates / deterministic order / critical primitives present) without running the suite; the
  checkpoint also fails loudly if any referenced script is missing.
- **Major primitive tests** present: timeline, target-provider, all process-template tests incl.
  activation-durability, Work Context primitive/visibility, handoff protocol, watcher, routing,
  connector, ops.
- **Smoke tests:** handoff smoke loop. **Page-render regression** and **build** are included.
- **Intentionally outside the checkpoint count** (run in each milestone's verification suite, kept
  off-count per the r1.32 decision): `triage-inbox-test.js`, `triage-resolution-test.js`,
  `demo-seed-test.js` — the coverage guard asserts these **exist on disk**.
- **Docs-only audits** follow the build-only convention.

## 13. Operational transparency audit

Reviewed `/ops` and `GET /api/ops/summary` (gated by `ops:read`): high-level counts; warning flags
(unresolved triage, blocked tickets, failed runs, connector read refusals, watcher failures, no
active Work Contexts, no routing policies, no connectors, version-consistency unresolved); bounded
recent failure/refusal lists; links to existing pages. Confirmed it performs **no writes on read**,
creates **no summary ledger**, and is deterministic (modulo `generatedAt`).

## 14. Demo fixture audit

Stated clearly: **fixtures are test/demo only and are not final product seed data.** Real businesses
will connect their own drives/data later. The current **local/mock connector is a contract fixture,
not a real external connector**, and its `local-connector-objects.json` store is a mock. Demo seed
data (`scripts/seed-demo-data.js`) is an isolated, git-ignored fixture.

## 15. Backup branch / concurrency audit

- The three `backup/*` branches **remain preserved**.
- The **foreign concurrent commits were not shipped** (`96223b7`, `db35df5` are not ancestors of
  `master`); the shipped r1.28 is the clean cherry-pick `8c00524`.
- The **release flow excludes backup branches** (documented in `docs/RELEASE_CHECKPOINT.md`); the
  read-only hygiene helper warns if a backup ever becomes an ancestor of `HEAD`.
- **Do not delete the backup branches without an explicit owner decision.**

## 16. Risks and blockers

**P0 — none found.** No hidden execution path; no authority bypass; no target mutation without a
receipt; no external connector credential surface (writes refused, credentialRef only); no
cross-context data leak (enforced + tested); checkpoint passes 43/43.

**P1 — none found.** Triage semantics are explicit (annotate-only); blocked work is surfaced (the
`/ops` surface and triage inbox both show it, and Work Context triage filtering is opt-in so
uncontexted/critical triage is never hidden by default); connector-vs-mock distinction is documented;
the operational surface covers the substrate.

**P2 (known limitations, documented — non-blocking):**

- **No real external connector yet** — only the local/mock contract.
- **Legacy records may lack newer fields** (e.g. pre-r1.10 tickets without `templateVersion`, runs
  without `routingSnapshot`) — by design (nullable, no backfill); they render safely.
- **Naming care needed** between *agent / provider / model* and *target / connector* — addressed in
  docs, worth a glossary in r1.34.
- **No production deployment guide yet** — to be authored in r1.34.
- **Durability note:** activation writes the version store then the root in two atomic writes; a
  crash between them is reconciled at startup (r1.12.2), but full cross-file transactionality is
  future hardening.

## 17. Release-candidate verdict

**Ready for release docs (with P2 notes).** No P0 or P1 blockers were found; the P2 items above are
documented known limitations and do not block release documentation.

## 18. Recommended r1.34 release docs scope

`r1.34-release-documentation` should include:

- a **README release overview**;
- an **operator guide**;
- a **primitive glossary** (Ticket/Run/Authority/Target/Evidence/Verification/Triage/Timeline/
  Template/Schedule/Work Context/Handoff/Watcher/Model Routing/Connector/Ops; plus agent/provider/
  model/target naming);
- **setup/run instructions**;
- **release checkpoint instructions** (link `docs/RELEASE_CHECKPOINT.md`);
- a **demo fixture explanation** (test/demo only, not product data);
- a **safety/non-goal section**;
- a **first-run walkthrough**;
- **troubleshooting**;
- a **backup branch note** (preserved, out of release flow).

It should be **docs-only** (no code/runtime change) and end with the release checkpoint green.

## 19. Final recommendation

- **Proceed to `r1.34-release-documentation`** — the audit found no P0/P1 blockers.
- **Do not add new primitives before release docs.**
- **Do not add real connectors before release docs.**
- **Do not add model-provider integrations before release docs.**
- **Preserve the current bounded substrate** — its coherence is the release-candidate's main asset.
