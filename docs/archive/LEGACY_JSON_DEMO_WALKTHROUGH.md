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
pnpm run demo:seed
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
pnpm run demo:dev
```

(equivalently `DATA_DIR=.local-demo-data WORKSPACE_ROOT=.local-demo-workspace pnpm run dev`)

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

The demo seeds these templates:

| Template | What it demonstrates |
| -------- | -------------------- |
| **Weekly status report** | Manual. Creates a clear, ordinary ticket; its detail shows **Created from template** provenance. Runs through the normal path like any other ticket. |
| **Ad-hoc folder batch** | Manual, intentionally ambiguous — **blocked by the existing objective clarification gate** (`objective_ambiguous` triage, **no run**). A template cannot bypass a safety gate just because it is reusable. |
| **Daily compliance digest** | **Scheduled** (`schedule.enabled: true`, `kind: "interval"`, UTC). When due, a scheduler scan creates one ordinary ticket whose detail shows scheduled provenance — `triggerType: "schedule"`, `triggeredBy: "system"`, a `schedule:<id>:<slot>` token, and `scheduledFor`. |
| **Archived intake digest** | **Disabled template** (`template.enabled: false`). Shows the **Template disabled** state. **Disable template** stops *both* manual and scheduled future ticket creation — a manual trigger returns the existing 409 and a scan creates nothing — yet its earlier generated ticket and provenance stay visible. **Enable template** restores it. |
| **Paused weekly export** | **Paused schedule** (`schedule.enabled: false`, `nextRunAt: null`, interval config retained). Shows the **Schedule paused** state. **Pause scheduled ticket creation** stops scheduled tickets only; **manual ticket creation is still available while only the schedule is paused.** **Resume scheduled ticket creation** recomputes `nextRunAt` forward from now. |

Scheduling is bounded on purpose: **there is no catch-up.** If an interval was missed (for
example the app was off), the next scan creates **one** ticket for the current slot — never a
storm of backfilled tickets. Repeating a scan does not duplicate a slot's ticket (the trigger is
idempotent on its deterministic token). The **run scheduler is unchanged** — it still only drains
pending runs **after** a ticket has been created the normal way.

**Operator controls (r1.9).** On `/process-templates` each template row offers **Disable template /
Enable template** and, for scheduled templates, **Pause scheduled ticket creation / Resume scheduled
ticket creation**. These affect **future template-created tickets only** — existing generated
tickets, runs, provenance, and `/logs` entries remain intact. **Paused schedules do not create
tickets.** **Resume** does not catch up missed intervals and does **not** create an immediate ticket
(the first ticket appears at the next due scan, one interval later); for an immediate ticket, use the
manual **Create ticket from template** button.

Every generated ticket records provenance, and each trigger (manual or scheduled) is written to
an append-only trigger log plus a `process_template:triggered` audit entry on `/logs`. Control
actions (disable/enable/pause/resume) are recorded as their own audit-log entries and are **never**
written to the trigger ledger, which is for created tickets only.

**Template version provenance (r1.10).** Each template carries a version (currently `v1` — shown
beside its name on `/process-templates`). A generated ticket now records **which template version
produced it**: open a templated ticket and its detail reads **"Created from template `<name>` v1"**.
The trigger ledger records the same `templateVersion` alongside the immutable `ticketTemplateSnapshot`
and `executionPolicyUsed` it already kept. **Template version is provenance** — it labels the producing
definition and is shown for audit. **Scheduled trigger tokens do not include the version**
(`schedule:<templateId>:<scheduledForIso>`), so scheduled idempotency stays per template + scheduled
slot regardless of version. **Versioning does not add editing** — there is still no template edit
UI/API and no version store; a future append-only edit/version model is explicitly out of scope here.
Older tickets created before this groundwork have no version and render safely without a version
suffix (e.g. the seeded "Archived intake digest" ticket).

**Append-only template versions: drafts & activation (r1.12).** Editing a template never happens
in place. `data/process-template-versions.json` stores **immutable** version records: a draft is a
*new* version record, and activation **supersedes** the prior active version and re-points the
template's active content — old records are never rewritten or deleted. The demo seeds this story on
**"Weekly status report"**: its active definition is materialized as **v1** and a pending **v2 draft**
sits beside it in the store, while the template still shows **v1** (the root stays on v1 until you
activate).

- **Drafts are harmless until activated.** Creating a draft writes only an immutable version record:
  it creates **no ticket, no run, and no workspace change**, and does not alter the active version. The
  seeded v2 draft is visible in the store while ticket #9 is still a v1 generated ticket and no v2
  ticket exists.
- **Activation changes future generated tickets only.** Activating the draft supersedes v1, marks v2
  active, and re-points the template's active content. It still creates **no ticket, no run, and no
  workspace change** by itself — it only changes what the *next* trigger produces.
- **Old tickets keep the version that created them.** Activation never rewrites past tickets, past
  runs, or past trigger-ledger entries. The seeded **v1 ticket #9 stays v1** (its detail still reads
  "Created from template `Weekly status report` v1"); a new ticket created *after* activation shows
  **v2**.
- **Pause scheduled ticket creation before activation.** When a template's schedule is enabled,
  activation is **blocked (409, "pause the schedule before activating a new version")** so a live
  schedule's future output is never silently changed. Pause the schedule, activate, then resume.
  Activation never touches the schedule cursor (`nextRunAt` / `lastScheduledTriggerAt`), so there is
  **no catch-up** and no backfilled storm.
- **Scheduled tokens do not include the version.** The scheduled idempotency token stays
  `schedule:<templateId>:<scheduledForIso>` regardless of which version is active — **version belongs
  in provenance, not in idempotency**. The trigger ledger records the producing `templateVersion`
  alongside the immutable `ticketTemplateSnapshot` and `executionPolicyUsed` it already kept.

Versioning still adds **no editing surface**: there is **no rich edit UI, no workflow builder, and no
old-version replay** — you cannot re-run or manually trigger a superseded version, and there is at most
one draft per template at a time. (A known durability note for a future hardening pass: activation
writes the version store and the root pointer in two sequential atomic writes, so a crash *between*
them could leave a brief root/store mismatch; reconciliation is out of scope here.)

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

Re-run `pnpm run demo:seed` to restore the fixture. To experiment with a fresh copy without
disturbing the demo, point the app at a different `DATA_DIR`.
