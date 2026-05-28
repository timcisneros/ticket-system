# Scheduler Tick Emission Review

## Summary

`scheduler.tick` is emitted unconditionally every 500 ms from `runtime/scheduler.js`. It accounts for **98.5% of all event lines** and **95.2% of `events.jsonl` bytes** — almost all with `pendingRuns: 0` (no state change). It is consumed only by telemetry reporting and test assertions; no replay, recovery, or enforcement logic depends on it.

---

## Emitter Location

| File | Line | Context |
|------|------|---------|
| `runtime/scheduler.js` | 44 | `type: 'scheduler.tick'` emitted inside `tick()` on every invocation |
| `runtime/scheduler.js` | ~43 | Interval is `RUNTIME_SCHEDULER_INTERVAL_MS` (default **500 ms**) |

The payload is:

```json
{
  "type": "scheduler.tick",
  "payload": { "pendingRuns": <number> }
}
```

---

## Noise Quantification (from `data/events.jsonl`)

| Metric | Value | % of Total |
|--------|-------|------------|
| Total event lines | 35,175 | 100% |
| `scheduler.tick` lines | 34,662 | **98.5%** |
| `scheduler.tick` with `pendingRuns: 0` | 34,640 | **98.4%** |
| Total file bytes | 6,558,851 | 100% |
| `scheduler.tick` bytes | 6,243,989 | **95.2%** |
| `scheduler.tick` with `pendingRuns: 0` bytes | 6,240,029 | **95.1%** |

**Interpretation:** the append-only event log is dominated by heartbeat events that carry no state change. On a quiet system, `events.jsonl` grows by ~1 line every 500 ms purely from `scheduler.tick`.

---

## Consumer Inventory

| File | Usage | Nature |
|------|-------|--------|
| `scripts/telemetry-report.js` (line 171) | Filters `scheduler.tick`, extracts `pendingRuns` into `pendingRunsOverTime`, computes `maxQueueDepth` and `avgQueueDepth` | **Functional** — derives operational-pressure metrics from tick events |
| `scripts/telemetry-test.js` (line 146) | Asserts `maxQueueDepth >= 0` and `avgQueueDepth >= 0` | **Assertion** — validates telemetry report structure |
| `scripts/workflow-composition-test.js` (line 392) | Asserts `persistedEventTypes.includes('scheduler.tick')` | **Sanity check** — confirms events are persisted; does not consume payload |

**Notable non-consumers:**
- `scripts/rebuild-runs-projection.js`
- `scripts/rebuild-tickets-projection.js`
- `scripts/event-chain-verify.js`
- `scripts/recovery-verifier.js`
- `scripts/resume-analyzer.js`
- `scripts/replay-reconstructor.js`
- `scripts/replay-verifier.js`
- All EJS views
- `server.js` (the API/UI does not read `scheduler.tick` events)

---

## Classification

### 1. Essential Evidence — **NO**

`scheduler.tick` is **not** required for:
- Reconstructing runs or tickets from events
- Verifying event chains or lifecycle invariants
- Recovery or resumption logic
- Replay or snapshot reconstruction
- Enforcement of authority or postconditions

Removing or reducing `scheduler.tick` would not break any correctness-critical path.

### 2. Operational Telemetry — **YES**

`scheduler.tick` is the sole source for two published metrics:
- `maxQueueDepth`
- `avgQueueDepth`

These are consumed by `scripts/telemetry-report.js` and tested by `scripts/telemetry-test.js`.

**Important caveat:** because the tick is emitted on a fixed interval regardless of state, `avgQueueDepth` is effectively a **time-sampled average**, not a true time-weighted average. If the tick were emitted only on change, the average would be computed over change points rather than over time, producing a different (and arguably less useful) number.

### 3. Debug Noise — **YES**

The unconditional emission means:
- On an idle system, `events.jsonl` grows at **~120 lines/minute** (~7200 lines/hour)
- 95% of the event log bytes are heartbeat records with `pendingRuns: 0`
- Log scanning, grep, and event replay are slowed by a 20× noise multiplier

---

## What Would Break If Tick Were State-Change-Only

| Consumer | Impact | Severity |
|----------|--------|----------|
| `telemetry-report.js` | `maxQueueDepth` remains correct (max over change points = max over all points). `avgQueueDepth` becomes unreliable (averages over change points, not time). | **Low–Medium** |
| `telemetry-test.js` | Assertions are `>= 0`; would still pass. | **None** |
| `workflow-composition-test.js` | Would still pass as long as at least one `scheduler.tick` is emitted during the test window. | **None** |
| All other scripts / runtime / UI | No impact. | **None** |

---

## Recommendation (informational only)

1. **Keep `scheduler.tick` as operational telemetry** for queue-depth metrics.
2. **Consider emitting only when `pendingRuns` changes** to reduce noise by ~95%.
3. If noise reduction is pursued, update `telemetry-report.js` to compute `avgQueueDepth` via an explicit time-weighted counter or separate metric source, since change-point sampling would no longer yield a time-based average.
4. No runtime, recovery, or enforcement change is required.

---

*Review generated from runtime/scheduler.js and data/events.jsonl on 2026-05-28.*
