# Demo Walkthrough

A deterministic, no-provider demo that shows the current product loop end to end:

```
ticket → run → verification → triage → /triage inbox → operator resolution/control
       → logs/audit → attempt/usage/budget visibility
```

This uses pre-seeded terminal runs and persisted triage/evaluation. **No OpenAI/Ollama
key is required** and no live model runs. It is demo data only — it changes no runtime
behavior.

## 1. Seed the demo data

```sh
npm run demo:seed
```

This writes an isolated fixture to `.local-demo-data/` (workspace `.local-demo-workspace/`),
both Git-ignored. It does not touch your normal `.local-data/`. Override the targets with
`DEMO_DATA_DIR` / `DEMO_WORKSPACE_ROOT` if needed.

The script is deterministic and idempotent: re-running fully replaces the demo directory and
prints whether it is **creating** or **replacing** it, so re-seeding never silently surprises
you. As a safety guard it refuses to seed into the repo `data/`, your normal `.local-data/`,
or the repo root.

## 2. Run the app against the demo data

```sh
npm run demo:dev
```

(equivalently `DATA_DIR=.local-demo-data WORKSPACE_ROOT=.local-demo-workspace npm run dev`)

Open the printed URL (default `http://localhost:3099`).

## 3. Login

```
username: admin
password: admin123
```

## 4. Click path

| Step | Where | What it demonstrates |
| ---- | ----- | -------------------- |
| 1 | `/tickets` | The seeded demo tickets, each labeled with the capability it shows. |
| 2 | open **"…(completed + verified)"** → its run | Verified completion: run detail shows **Objective Success: Yes**, the verification contract snapshot, and Usage/Attempt. |
| 3 | open **"…(verification failed → run triage)"** → its run | A failed run with **Triage Required** (reason `verification_failed`, required decision, summary, allowed/prohibited actions). |
| 4 | `/triage` | The operator triage inbox: unresolved **ticket-level** triage (the blocked "…protected legal archive" ticket and the `objective_ambiguous` "…Michael Jackson songs" ticket) and **run-level** triage (the failed verification run), each linking to detail. Resolved triage is **not** listed. |
| 5 | run detail (from `/triage`) | Why the item needs attention; the existing **Resolve triage** control (gated by `ticket:update`). Resolving records who/when/why — it does **not** rerun, complete, or change status. |
| 6 | `/runs/<id>` for the budget ticket | **Budget (advisory)**: recorded usage vs the run's recorded thresholds, showing `exceeded (advisory)`. Advisory only — nothing is blocked. |
| 7 | open **"…(manual rerun ceiling: maxAttempts 2)"** ticket | Execution Policy shows **Max attempts: 2 · enforced for manual rerun-from-start**; other fields are recorded intent. The operator control to set/clear the ceiling lives here. |
| 8 | open **"…(run triage resolved)"** → its run | A **Triage (resolved)** annotation with resolved-by / resolved-at / resolution. |
| 9 | `/logs` | The durable audit trail, including `ticket:max_attempts_change` and `run:triage_resolve` operator-control entries. |
| 10 | any ticket detail | **Budget Advisory** rollup across the ticket's runs (advisory only). |

## 5. Process templates (manual + scheduled)

Open **`/process-templates`** (the **Templates** nav link, gated by `processTemplate:manage`).
A process template is a **reusable ticket starter** — it stores a ticket's objective,
assignment, and policy so the same ticket can be created again without retyping it.

A template creates tickets two ways, and **both create ordinary tickets, not work**:

- **Manual** — pressing **"Create ticket from template"** creates one ordinary ticket now.
- **Scheduled** — **"Schedule ticket creation from this template"** creates one ordinary ticket
  each interval (r1.7 supports **interval seconds in UTC only** — no cron, no calendar, no
  daily/timezone modes). A schedule does **not** run work on its own; it only creates a ticket,
  which then flows through the **same** run, triage, verification, and policy controls as any
  hand-entered ticket.

The demo seeds three enabled templates:

| Template | What it demonstrates |
| -------- | -------------------- |
| **Weekly status report** | Manual. Creates a clear, ordinary ticket; its detail shows **Created from template** provenance. Runs through the normal path like any other ticket. |
| **Ad-hoc folder batch** | Manual, intentionally ambiguous — **blocked by the existing objective clarification gate** (`objective_ambiguous` triage, **no run**). A template cannot bypass a safety gate just because it is reusable. |
| **Daily compliance digest** | **Scheduled** (`schedule.enabled: true`, `kind: "interval"`, UTC). When due, a scheduler scan creates one ordinary ticket whose detail shows scheduled provenance — `triggerType: "schedule"`, `triggeredBy: "system"`, a `schedule:<id>:<slot>` token, and `scheduledFor`. |

Scheduling is bounded on purpose: **there is no catch-up.** If an interval was missed (for
example the app was off), the next scan creates **one** ticket for the current slot — never a
storm of backfilled tickets. Repeating a scan does not duplicate a slot's ticket (the trigger is
idempotent on its deterministic token). The **run scheduler is unchanged** — it still only drains
pending runs **after** a ticket has been created the normal way.

Every generated ticket records provenance, and each trigger (manual or scheduled) is written to
an append-only trigger log plus a `process_template:triggered` audit entry on `/logs`.

## What is intentionally NOT automated yet

This demo is a **visibility, navigation, and human-control** surface. It deliberately does
**not** include: automatic retry, hard budget enforcement, run cancellation, remediation or
approval workflows, child-ticket execution, or any rerun-from-triage. Scheduled process templates
**only create tickets** on a fixed UTC interval (no catch-up) — there is no background loop that
executes work, no template that wakes another template, and no autonomous ticket spawning beyond
that single bounded per-interval ticket. `maxAttempts` is the only enforced policy field, and only
for **manual** rerun-from-start. Triage resolution is a human acknowledgement that never changes
completion or verification outcomes. See `docs/AUTHORITY_AND_DURABILITY.md` for where this state
lives.

## Resetting

Re-run `npm run demo:seed` to restore the fixture. To experiment with a fresh copy without
disturbing the demo, point the app at a different `DATA_DIR`.
