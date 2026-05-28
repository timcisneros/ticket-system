# Evidence vs Telemetry vs Debug Output in the Substrate

## Summary

The substrate has three distinct output classes with different durability, consumption, and trust requirements. The append-only `events.jsonl` is **intended** to contain **evidence only** (Option A). In practice it leaks two telemetry events (`scheduler.tick`, `run.heartbeat`), making the current file **evidence + telemetry** (Option B). Debug output is explicitly excluded from `events.jsonl`.

---

## Criteria by Category

### 1. Evidence

**Definition:** A record of a state-mutating or decision-boundary event that is required to reconstruct runtime state, verify correctness, or satisfy audit requirements.

| Criterion | Description |
|-----------|-------------|
| **Purpose** | Prove that something happened. Must be sufficient to reconstruct projections (runs, tickets, workspace state) and verify invariants independently of mutable state files. |
| **Retention expectations** | Indefinite. Append-only. Cannot be rewritten, summarized, or dropped without breaking reproducibility guarantees. |
| **Replay value** | **High.** Event is consumed by `scripts/projection-rebuilder.js`, `scripts/replay-reconstructor.js`, or `scripts/recovery-verifier.js` to rebuild state or verify hash chains. |
| **Recovery value** | **High.** Missing evidence means `reconstructResumableState` cannot determine phase, lease state, or mutation history after a restart. |
| **Audit value** | **High.** Evidence is the source of truth for authority checks, phase compliance, terminalization correctness, and workspace mutation lineage. |

**Concrete substrate examples:**

| Event type | Why it is evidence |
|------------|-------------------|
| `run.created` | Required to derive agent assignment and initial run state in projection rebuilders. |
| `run.started` | Required to set `status = 'running'`, derive `startedAt`, and establish lifecycle phase. |
| `run.execution_completed` | Required to detect terminal state and distinguish completed from interrupted runs. |
| `run.terminalized` | Required for terminalization-correctness invariant (`terminalizedCount <= executionCompletedCount`). |
| `run.snapshot_finalized` | Required to know whether replay snapshot was sealed before restart. |
| `run.evaluation_completed` | Required for lifecycle phase reconstruction (`evaluation_completed` vs `snapshot_finalized`). |
| `run.consequence_recorded` | Required for lifecycle phase reconstruction and consequence audit. |
| `workspace.operation` | Required to reconstruct workspace projection and mutation count. |
| `execution.phase_transition` | Required by `reconstructResumableState` to restore `run.currentPhase` after restart. |
| `execution.phase_violation` | Required for failure-metrics telemetry and authority audit. |
| `authority.allowed` / `authority.denied` | Required for authority-graph reconstruction and enforcement audit. |
| `action.suppressed` | Required to prove enforcement boundaries were applied. |
| `run.violations_checked` / `run.violation_detected` | Required for violation metrics and post-execution audit. |
| `run.lease_acquired` / `run.lease_expired` / `run.resumed` | Required for lease-state reconstruction and resumption safety checks. |
| `ticket.created` / `ticket.updated` | Required for ticket projection rebuilders. |
| `workflow.step.completed` / `workflow.draft_created` | Required to reconstruct workflow execution history. |
| `scheduler.run_selected` / `scheduler.capacity_blocked` / `run.queued` | Required to reconstruct scheduler decisions and queue state. |

**Note on user examples:** The user suggested `action.executed` and `verification.completed`. The substrate does not emit events with those exact names. The equivalents are `workspace.operation` (for executed workspace actions) and `run.violations_checked` / `run.postconditions_checked` / `batch.verification_failed` (for verification outcomes).

---

### 2. Telemetry

**Definition:** A periodic or sampled observation of operational state that is useful for metrics and monitoring but is not required to reconstruct runtime state or prove a decision boundary.

| Criterion | Description |
|-----------|-------------|
| **Purpose** | Answer "how is the system behaving?" — queue depth, lease freshness, loop health. Not a proof of action. |
| **Retention expectations** | Time-bounded. Useful for recent operational dashboards. Can be downsampled or expired without breaking correctness. |
| **Replay value** | **Low / None.** Replay does not need telemetry to reproduce behavior; it needs evidence of decisions and mutations. |
| **Recovery value** | **Low.** A missing heartbeat or tick does not prevent resumption; the mutable `runs.json` lease fields are sufficient. |
| **Audit value** | **Low.** Telemetry is observational, not probative. A tick with `pendingRuns: 3` does not prove three runs were actually started. |

**Concrete substrate examples:**

| Event type | Why it is telemetry |
|------------|-------------------|
| `scheduler.tick` | Emitted every 500 ms with `pendingRuns` count. Consumed only by `scripts/telemetry-report.js` for `maxQueueDepth` and `avgQueueDepth`. Not used by any projection, replay, or recovery script. |
| `run.heartbeat` | Emitted on every model-request heartbeat with lease metadata. **Borderline case:** it is used by `recovery-verifier.js` phase map and `resume-analyzer.js` as a phase marker, and by `replay-reconstructor.js` as a proxy for provider-request counting. However, its primary purpose is lease liveness signaling, and its recovery usage is incidental (the same phase information could be inferred from surrounding evidence events). |

---

### 3. Debug Output

**Definition:** Transient, human-oriented diagnostic text used for local troubleshooting. Not structured, not consumed by automation, and not required for any correctness path.

| Criterion | Description |
|-----------|-------------|
| **Purpose** | Help a human understand what the system is doing right now. |
| **Retention expectations** | Ephemeral. May be discarded after the troubleshooting session. |
| **Replay value** | **None.** Debug output is not replayed; it describes internal state that should be derivable from evidence anyway. |
| **Recovery value** | **None.** Recovery depends on structured evidence, not human-readable narrative. |
| **Audit value** | **None.** Debug output is not signed, sequenced, or hashed. It is not trustworthy as audit evidence. |

**Concrete substrate examples:**

| Output type | Location | Nature |
|-------------|----------|--------|
| `console.log` / `console.error` in `server.js` | stdout/stderr | Startup diagnostics, bootstrap messages, flush errors. Never written to `events.jsonl`. |
| `appendRunLog()` entries | `data/logs.json` | Human-readable run narrative (`run:started`, `workspace:write`, `model:request`). Stored in a separate mutable file, not the append-only event log. |

---

## Cross-Category Decision Matrix

| Test | Evidence | Telemetry | Debug |
|------|----------|-----------|-------|
| If removed, does projection rebuilder break? | Yes | No | N/A |
| If removed, does recovery verifier chain break? | Yes | No | N/A |
| If removed, does replay reconstructor output change materially? | Yes | No (for `scheduler.tick`; minor for `run.heartbeat`) | N/A |
| Is it hashed / sequenced in the run event chain? | Yes | `scheduler.tick` is not sequenced; `run.heartbeat` is | No |
| Is it consumed by telemetry-report.js for metrics? | Some (violations, authority) | Yes (`scheduler.tick`, `run.heartbeat`) | No |
| Is it consumed by operational dashboards? | No | Yes | No |
| Can it be derived from other events? | No (it is the source) | Yes (`scheduler.tick` could be replaced by polling `runs.json`) | N/A |

---

## What Is `events.jsonl` Intended to Contain?

### Answer: **A. Evidence only**

**Supporting evidence:**

1. **Design documentation** — `docs/OPERATIONAL_TELEMETRY.md` states Principle 1 is **"Evidence-only: Every metric is computed from persisted ledger files. No hidden mutable counters."**
2. **Projection rebuilder contracts** — `scripts/rebuild-runs-projection.js` header declares it "reconstruct runs.json from events.jsonl (source of truth)." A source of truth for state reconstruction must be evidence.
3. **Replay reconstructor contract** — `scripts/replay-reconstructor.js` states "Events are source of truth." It does not require `scheduler.tick` to function.
4. **Evidence preservation principle** — `docs/EVIDENCE_PRESERVATION_PRINCIPLE.md` treats `appendEvent` as an evidence preservation surface, with the only noted loss being `sanitizeSnapshotValue` redaction, not event removal.
5. **AGENTS.md description** — "`data/events.jsonl` is append-only operational history." The phrase "operational history" implies a record of operations (evidence), not a stream of observations (telemetry).

### Why the actual file is Option B (Evidence + Telemetry)

- `scheduler.tick` accounts for **98.5% of event lines** but is never used for state reconstruction. It is purely telemetry.
- `run.heartbeat` is borderline but primarily telemetry; its presence in recovery scripts is incidental.

These two event types leak telemetry into the evidence log. They are not debug output (Option C is incorrect because `console.log` and `appendRunLog` never write to `events.jsonl`).

### Why Option C is wrong

There are **zero** debug events in `events.jsonl`. Debug output is routed to:
- `console.log` / `console.error` → stdout/stderr
- `appendRunLog` → `data/logs.json`

The substrate maintains a clean separation: `events.jsonl` is structured, append-only, and evidence-oriented; `logs.json` is human-readable, mutable, and debug-oriented.

---

## Conclusion

| Surface | Intended contents | Actual contents |
|---------|-------------------|-----------------|
| `events.jsonl` | **A. Evidence only** | **B. Evidence + Telemetry** (due to `scheduler.tick` and `run.heartbeat` leakage) |
| `logs.json` | Debug + narrative | Debug + narrative |
| stdout/stderr | Transient diagnostics | Transient diagnostics |

The classification gap is small in type count (2 telemetry events) but massive in volume (`scheduler.tick` is 98.5% of lines). If the substrate were aligned with its documented intent, `scheduler.tick` would be removed from `events.jsonl` and computed on-demand by telemetry scripts from `runs.json` polling or a separate metrics stream.

---

*Document generated from inspection of `runtime/scheduler.js`, `server.js`, `scripts/projection-rebuilder.js`, `scripts/replay-reconstructor.js`, `scripts/recovery-verifier.js`, `scripts/telemetry-report.js`, `data/events.jsonl`, and design docs on 2026-05-28.*
