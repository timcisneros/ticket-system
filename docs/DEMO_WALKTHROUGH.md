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

## 5. Process templates (manual)

Open **`/process-templates`** (the **Templates** nav link, gated by `processTemplate:manage`).
A process template is a **reusable ticket starter** — it stores a ticket's objective,
assignment, and policy so an operator can create that ticket again without retyping it.

Triggering is **manual only**. Pressing **"Create ticket from template"** creates one ordinary
ticket and nothing else — there is no schedule, no background job, and no process that runs on
its own. The generated ticket then flows through the **same** run, triage, verification, and
policy controls as any hand-entered ticket.

The demo seeds two enabled templates (`triggerType: "manual"`, `schedule: null`):

| Template | What a manual trigger demonstrates |
| -------- | ---------------------------------- |
| **Weekly status report** | Creates a clear, ordinary ticket. Its detail shows **Created from template** provenance (template name, who triggered it, manual trigger). It then runs through the normal path like any other ticket. |
| **Ad-hoc folder batch** | Has an intentionally ambiguous objective, so a manual trigger is **blocked by the existing objective clarification gate** — the generated ticket lands in triage (`objective_ambiguous`) and **no run is created**. A template cannot bypass a safety gate just because it is reusable. |

Every generated ticket records provenance, and each trigger is written to an append-only
trigger log plus a `process_template:triggered` audit entry on `/logs`. Repeating the same
trigger token returns the original ticket instead of creating a duplicate.

## What is intentionally NOT automated yet

This demo is a **visibility, navigation, and human-control** surface. It deliberately does
**not** include: automatic retry, hard budget enforcement, run cancellation, remediation or
approval workflows, child-ticket execution, or any rerun-from-triage. Process templates are
**manual-trigger only** — there is no scheduler, no background loop, no template that wakes
another template, and no autonomous ticket spawning. `maxAttempts` is the only enforced policy
field, and only for **manual** rerun-from-start. Triage resolution is a human acknowledgement
that never changes completion or verification outcomes. See
`docs/AUTHORITY_AND_DURABILITY.md` for where this state lives.

## Resetting

Re-run `npm run demo:seed` to restore the fixture. To experiment with a fresh copy without
disturbing the demo, point the app at a different `DATA_DIR`.
