# Event Log Intent Review

## Question

What was `events.jsonl` originally intended to be?

---

## 1. Definitions Found in Documentation

### AGENTS.md

> `data/events.jsonl` is append-only operational history; legacy JSON files still exist and are rewritten by current persistence helpers.

Term used: **"append-only operational history"**

### scripts/rebuild-runs-projection.js

> Rebuild Runs Projection — reconstruct runs.json from events.jsonl (source of truth).

Term used: **"source of truth"**

### scripts/replay-reconstructor.js

> Does NOT require replay snapshot. Events are source of truth.

Term used: **"source of truth"**

### docs/OPERATIONAL_TELEMETRY.md

> `events.jsonl` — Append-only event log

Term used: **"Append-only event log"**

Contents listed as: "Phase transitions, violations, queue depth, authority checks, terminalization events"

This explicitly includes **queue depth** as a documented content type.

### docs/EXECUTION_PHASES.md

> When resuming a run, `reconstructResumableState` replays phase transition events from the event log to restore `run.currentPhase`.

Term used: **"event log"**

### STATE_SURFACES.md

> All 7 surfaces below describe recorded operational history — mutations, runs, failures, allocations, continuations, budgets, diffs. They are evidence of what happened.

Term used: **"recorded operational history"** / **"evidence of what happened"**

Note: This describes the *surfaces* collectively, not `events.jsonl` specifically.

### docs/EVIDENCE_PRESERVATION_PRINCIPLE.md

> `appendEvent` (line 2075) writes to `data/events.jsonl` in append-only fashion.

Describes the *mechanism* (append-only), not the *content boundary*.

---

## 2. What It Is NOT Explicitly Defined As

| Term | Found in any doc? |
|------|-------------------|
| "evidence log" | **No** |
| "event sourcing log" | **No** |
| "telemetry stream" | **No** |
| "mixed stream" | **No** |

The term **"event log"** is used (OPERATIONAL_TELEMETRY.md, EXECUTION_PHASES.md), but it is not qualified with "evidence-only" or "telemetry-only."

---

## 3. Is There an Explicit Design Decision That Excludes Telemetry?

**No.**

No document states:
- "Telemetry events shall not be written to `events.jsonl`"
- "Only state-mutating events may be emitted via `appendEvent`"
- "Observational events are excluded from the event log"

The `appendEvent` function in `server.js` (line 2075) accepts any `type` string and normalizes it without restriction. There is no allow-list or block-list for event types.

The `event-chain-verify.js` script explicitly handles events with `runId == null` (non-run events) and counts them as `nonRunEvents` — a design that accommodates global/telemetry events without rejecting them as invalid.

---

## 4. Did `scheduler.tick` Violate a Documented Contract?

**No.**

### Evidence that no contract was violated

1. **No event-type restriction exists.** The `appendEvent` function accepts any string type. No doc restricts what may be appended.

2. **Telemetry doc explicitly documents `scheduler.tick` as a source.** `docs/OPERATIONAL_TELEMETRY.md` line 66-67:
   > Max queue depth | events.jsonl `scheduler.tick` | Max `payload.pendingRuns` over all tick events
   > Avg queue depth | events.jsonl `scheduler.tick` | Mean `payload.pendingRuns` over all tick events

   This is not an accident or a leak; it is a documented, designed telemetry input.

3. **Test assertions codify its presence.**
   - `scripts/telemetry-test.js` line 146: "Queue depth should come from scheduler.tick events, not a counter"
   - `scripts/workflow-composition-test.js` line 392: "events.jsonl should include scheduler.tick"

   These tests were written to validate the system as it exists. They confirm `scheduler.tick` was an intentional part of the telemetry contract.

4. **Lifecycle event contract does not claim exclusivity.** `docs/LIFECYCLE_EVENTS.md` defines 5 canonical events for terminalization logic, but does not say "only these 5 events may exist in the log."

### What actually happened

`scheduler.tick` **exposed an ambiguity**, not a violation.

The ambiguity is in the dual use of the same file:
- **Projection rebuilders** treat `events.jsonl` as a source of truth for reconstructing runs and tickets. They ignore `scheduler.tick` (it has no `runId`).
- **Telemetry system** treats `events.jsonl` as a stream from which to derive queue-depth metrics. It depends on `scheduler.tick`.

Both systems function correctly. Neither contradicts a documented contract. The ambiguity is that the file serves two consumers with different expectations, yet no boundary was ever drawn between reconstructive events and observational events.

---

## 5. The Narrowest Statement Supported by Evidence

`events.jsonl` is documented in `AGENTS.md` as **"append-only operational history,"** in projection rebuilders as a **"source of truth"** for run/ticket reconstruction, and in `OPERATIONAL_TELEMETRY.md` as an **"append-only event log"** that explicitly includes queue-depth observations from `scheduler.tick`. No document restricts which event types may be emitted, and the telemetry system was designed assuming `scheduler.tick` events are present. Therefore, `scheduler.tick` did not violate a documented contract; it reveals that the file serves dual purposes (state reconstruction and telemetry derivation) without an explicit boundary between them.

---

*Document generated from inspection of AGENTS.md, docs/OPERATIONAL_TELEMETRY.md, docs/EXECUTION_PHASES.md, docs/EVIDENCE_PRESERVATION_PRINCIPLE.md, docs/LIFECYCLE_EVENTS.md, docs/SUBSTRATE_DESIGN_PRINCIPLES.md, docs/STATE_SURFACES.md, scripts/rebuild-runs-projection.js, scripts/replay-reconstructor.js, scripts/event-chain-verify.js, scripts/telemetry-test.js, scripts/workflow-composition-test.js, and server.js on 2026-05-28.*
