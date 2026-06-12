# Unresolved Event Log Questions

## 1. Should operational history contain telemetry?

`AGENTS.md` defines `events.jsonl` as "append-only operational history."

- Does "operational history" mean a record of operations the system performed, or does it include observations of system state?
- Is a `scheduler.tick` event (pendingRuns count every 500ms) an operation or an observation?
- Is `run.heartbeat` (lease metadata on every model request) an operation or an observation?
- If operational history includes observations, what observations are in scope and which are out of scope?
- If operational history excludes observations, what stream should observations use?

## 2. Should evidence and telemetry share a stream?

The same `events.jsonl` file is:
- A "source of truth" for projection rebuilders and replay reconstructors
- A "ledger" from which telemetry metrics are derived

- Is sharing a single append-only stream between state reconstruction and observational metrics intentional or incidental?
- If shared intentionally, is there a documented rationale?
- If shared incidentally, was a separation ever considered and rejected?
- What is the cost to projection rebuilders of scanning telemetry events that carry no reconstructive value?
- What is the cost to telemetry consumers if telemetry events are separated from the reconstructive stream?

## 3. What properties distinguish reconstructive events from observational events?

Currently, the distinction is implicit:
- `run.started`, `workspace.operation`, `execution.phase_transition` — consumed by replay/reconstruction
- `scheduler.tick` — not consumed by replay/reconstruction
- `run.heartbeat` — partially consumed (phase map, provider request proxy)

- Is the distinction defined by whether the event has a `runId`? (`scheduler.tick` has no `runId`; most reconstructive events do.)
- Is the distinction defined by whether the event is hashed/sequenced in the run event chain? (`scheduler.tick` is not sequenced; most run events are. `run.heartbeat` is sequenced.)
- Is the distinction defined by whether the event changes mutable state? (`scheduler.tick` does not mutate `runs.json`; most reconstructive events do.)
- Is the distinction defined by consumer usage? (If a new consumer starts using `scheduler.tick` for reconstruction, does it change categories?)
- Is there a formal taxonomy of event types that the substrate intends to maintain?

## 4. Should retention differ by category?

`events.jsonl` is append-only. No documented expiration or compaction exists.

- Should reconstructive events be retained indefinitely?
- Should observational events (e.g., `scheduler.tick` with `pendingRuns: 0`) be retained indefinitely?
- If observational events are not retained indefinitely, what is the minimum retention needed for telemetry accuracy?
- If observational events are compacted or expired, does the "append-only" contract apply uniformly or per-category?
- Does the telemetry system's determinism guarantee (same ledger → identical report) require all historical ticks, or only ticks during active runs?
- If retention differs by category, how does the system express that policy? (File-level? Event-type-level? Consumer-level?)

## 5. Should replay consumers ignore categories explicitly or implicitly?

Current behavior:
- `scripts/projection-rebuilder.js` ignores `scheduler.tick` (no `runId`, so it is not grouped by run)
- `scripts/replay-reconstructor.js` ignores `scheduler.tick` (not referenced in reconstruction logic)
- `scripts/event-chain-verify.js` counts `scheduler.tick` as `nonRunEvents` but does not flag it as an error

- Should replay/reconstruction tools explicitly filter out known observational event types?
- Should replay/reconstruction tools implicitly ignore events they do not recognize?
- If explicit filtering is preferred, where is the filter list maintained?
- If implicit ignoring is preferred, what prevents an observational event from being accidentally reconstructed into a run state?
- Should the event chain verifier treat non-run events as valid (current behavior) or as a warning?
- Should tests that assert event log contents (e.g., "events.jsonl should include scheduler.tick") be considered part of the contract, or are they implementation-detail assertions that could be removed without semantic impact?

## 6. Additional open questions

- Should `appendEvent` enforce any boundary on what event types may be emitted, or should it remain an unrestricted append surface?
- Should telemetry events carry the same forensic metadata (seq, prevHash) as run events, or is the absence of seq/prevHash on `scheduler.tick` a signal that it is not part of the reconstructive chain?
- Is the `OPERATIONAL_TELEMETRY.md` principle "Evidence-only" ("Every metric is computed from persisted ledger files") intended to mean "metrics are derived only from evidence," or "metrics are derived from whatever is in the ledger, including telemetry"?
- If the event log grows by ~120 lines/minute on an idle system, at what point does file size become an operational concern for append performance, read performance, or storage cost?

---

*Document generated from inspection of AGENTS.md, docs/OPERATIONAL_TELEMETRY.md, docs/LIFECYCLE_EVENTS.md, docs/EVIDENCE_PRESERVATION_PRINCIPLE.md, server.js appendEvent, scripts/rebuild-runs-projection.js, scripts/replay-reconstructor.js, scripts/event-chain-verify.js, scripts/telemetry-test.js, scripts/workflow-composition-test.js, and data/events.jsonl on 2026-05-28.*
