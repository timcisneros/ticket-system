# Handoff Smoke Tests & Demo Scenarios

r1.24 adds a single deterministic, no-provider smoke test
(`scripts/handoff-smoke-test.js`) that exercises the full human/agent handoff queue loop
end-to-end using only the existing r1.23 protocol and r1.20/r1.21 Work Context surfaces. It adds
**no runtime behavior** — it is validation/demo hardening only.

> **Framing:** these scenarios are **test/demo fixtures only**. In the real product a business
> connects its own drives/data; the seeded tickets/runs/contexts here are **not** final product
> seed data.

## What r1.24 proves

The queue loop, proven without any model/provider call:

```
request → ticket created → agent claims → claim receipt visible → agent works
→ work receipt visible → ambiguity becomes blocked/triage (not guessed)
→ human resolves on the same ticket → resume requires normal run/rerun
→ agent proposes handoff → handoff creates a normal ticket with source/evidence refs
→ recipient claims normally → timeline shows the chain → no hidden work exists
```

## Scenario 1 — basic claim / work / receipt

A Work Context holds a source ticket with a claimed, terminal run. The smoke test asserts the
**Claim Receipt** is derivable (`GET /api/runs/:id/claim-receipt`) with ticket/run/actor/lease/work
context, the **Work Receipt** is derived from existing evidence (`GET /api/runs/:id/work-receipt`)
and exposes **no file contents or provider bodies**, and the **timeline** shows both the claim
(`run.lease_acquired`) and the `run.work_receipt`. Reading these surfaces mutates no workspace.

## Scenario 2 — ambiguity to triage / needs-input

A handoff with an ambiguous objective is **blocked with `objective_ambiguous` triage** and the
exact `requiredDecision` (`clarify_objective`) is recorded — it creates **no run** (no guessing).
A human resolves on the **same ticket** through the normal triage-resolution path; resolution
annotates (resolved-at/by/note) **without** rewriting the handoff provenance or prior events, and
creates **no run** — resuming would require normal run/rerun semantics.

## Scenario 3 — agent-to-agent handoff through normal ticket creation

A handoff from a source ticket/run creates an **ordinary ticket** via the normal authorized path,
carrying a **Handoff Receipt** on `source` (from-ticket/run/actor, to-assignee, work context,
`sourceRefs`, `evidenceRefs`, `constraints`, `authorityLimits`, `stopCondition`,
`receiptExpectation`, `status`). The recipient ticket is **not secretly claimed** — it has a normal
pending run with no lease, to be claimed normally. The handoff respects `ticket:create` (a
read-only user is 403), is rejected into an **archived** Work Context (no scope bypass), does not
widen authority, and opens **no private agent-to-agent channel**. The created ticket's timeline
shows the handoff provenance.

## Scenario 4 — Work Context visibility after handoff

The Work Context summary (`GET /api/work-contexts/:id/summary`) includes the source and the
handoff-created tickets; `/tickets?workContextId=` and `/triage?workContextId=` filter to the
context; `/process-templates?workContextId=` is unaffected. **Uncontexted/critical triage is not
hidden by default** — it only narrows when the operator explicitly filters.

## Scenario 5 — no hidden state / no new ledgers

Before/after digests of the temp DATA_DIR and workspace assert: **no unexpected data files**
created (no handoff/claim/work-receipt/context-summary/timeline ledger), the Work Context store and
all process-template/version data are byte-unchanged (no scheduler-token changes), the source
ticket and run are not rewritten, `events.jsonl` is only appended to (append-only), the workspace is
unmutated (no run executed), and **every handoff is a visible ordinary ticket** (no hidden work).

## Why this comes before watchers / model routing / connectors

The handoff queue is the substrate those features would build on. Proving — deterministically —
that work moves between humans and agents through **explicit, receipt-backed, visible tickets**
(never chat, never hidden work, never a private channel) is the precondition for safely adding any
ambient or autonomous behavior later.

## What it deliberately does not prove

- It does **not** run a live agent/model; runs are seeded terminal evidence (the established
  no-provider pattern).
- It does **not** exercise the runtime scheduler executing a claimed run end-to-end (that needs a
  provider); it proves the **protocol surfaces** (claim/work/handoff receipts, triage, timeline,
  visibility), not live execution.
- It does **not** introduce or test watchers, connectors, memory, or model routing.

## What remains for future r1.25 bounded watcher design

A future `r1.25` audit should design a **bounded watcher** that may observe context sources,
summarize, raise triage, propose a ticket, and notify — but may **not** mutate targets, run
arbitrary templates, bypass authority, spawn work without ticket creation, wake agents directly, or
operate unaudited. The watcher rides on this handoff queue; it never replaces it.
