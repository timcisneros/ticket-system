# Operational Telemetry

## Overview

The substrate exposes its behavior as measurable operational evidence. All telemetry is derived deterministically from the ledger (events.jsonl, runs.json, tickets.json, operation-history.json). No hidden mutable counters are maintained.

> The semantic definitions these surfaces implement originate in `docs/STATE_SURFACES.md`, which also records surfaces not yet implemented.

## Principles

1. **Evidence-only**: Every metric is computed from persisted ledger files. No in-memory counters.
2. **Deterministic**: Running the telemetry engine twice on the same ledger produces identical outputs.
3. **Replayable**: Replaying the event log reproduces the same telemetry report.
4. **No hidden state**: The telemetry engine is a pure function of the ledger. It does not write to the ledger.

## Ledger Sources

| Source | Contents | Used For |
|--------|----------|----------|
| `events.jsonl` | Append-only event log | Phase transitions, violations, queue depth, authority checks, terminalization events |
| `runs.json` | Run records with replaySummary | Status, model, steps, operations, duration, failure classification |
| `tickets.json` | Ticket objectives | Profile detection (report, diagnosis, refactor, etc.) |
| `operation-history.json` | Mutation ledger | Commit conflicts, mutation counts, artifact paths |

## Metrics

### 1. Workload Profile Metrics

The telemetry engine detects the workload profile from each ticket objective and aggregates run statistics per profile.

| Metric | Source | Computation |
|--------|--------|-------------|
| Runs by profile | tickets.json + runs.json | `detectProfile(objective)` on each ticket, then group terminal runs |
| Success rate | runs.json | `completed / total` per profile |
| Avg execution steps | runs.json replaySummary | `steps` averaged per profile |
| Avg model requests | runs.json replaySummary | `providerRequests` averaged per profile |
| Avg workspace operations | runs.json replaySummary | `workspaceOperations` averaged per profile |
| Avg mutations | runs.json replaySummary | `mutationCount` averaged per profile |

**Profiles:** report, diagnosis, refactor, recommendation, bulk-inventory, other

### 2. Failure Metrics

| Metric | Source | Event Type / Field |
|--------|--------|-------------------|
| Phase violations | events.jsonl | `execution.phase_violation` |
| Authority denials | events.jsonl | `authority.denied` |
| Action suppressed | events.jsonl | `action.suppressed` |
| Commit conflicts | operation-history.json | Duplicate `(runId, operation, args)` tuples |
| Non-progress loops | runs.json replaySummary | `failure.kind === 'step'` with stalled message |
| Limit exhaustion | runs.json replaySummary | `failure.code === 'RUN_LIMIT_EXCEEDED'` |
| OOM failures | runs.json | `error` field matches memory/OOM pattern |
| Model failures | runs.json | `error` field matches model/provider pattern (excluding OOM) |

### 3. Model Reliability Metrics

| Metric | Source | Computation |
|--------|--------|-------------|
| Success rate by model | runs.json replaySummary.model | `completed / total` per model |
| Failure rate by profile | runs.json + tickets.json | `failed / total` per profile |
| Avg runtime duration | runs.json startedAt/completedAt | `completedAt - startedAt` averaged per model |
| Terminalization correctness | events.jsonl | `run.terminalized` count vs `run.execution_completed` count |

### 4. Operational Pressure Metrics

| Metric | Source | Computation |
|--------|--------|-------------|
| Max queue depth | events.jsonl `scheduler.tick` | Max `payload.pendingRuns` over all tick events |
| Avg queue depth | events.jsonl `scheduler.tick` | Mean `payload.pendingRuns` over all tick events (computed over emitted ticks; with no ticks the value is 0) |

> **`scheduler.tick` emission contract:** `scheduler.tick` is emitted only when the
> scheduler observes pending work (`pendingRuns.length > 0`). Idle ticks are not
> written to the evidence log, so queue-depth metrics are derived from observed
> non-empty ticks; an absence of ticks means the queue was empty (depth 0).
| Active runs | events.jsonl | Count of `run.started` events |
| Recovery count | events.jsonl | Count of `run.resumed` events |
| Lease expired | events.jsonl | Count of `run.lease_expired` events |
| Checkpoint restores | events.jsonl | Count of `replay.snapshot.finalized` + `run.snapshot_finalized` events |

### 5. Artifact Metrics

| Metric | Source | Computation |
|--------|--------|-------------|
| Total writeFile operations | operation-history.json | Count of `operation === 'writeFile'` |
| Report artifacts | operation-history.json | writeFile paths matching `\.(md|txt|rst)$` |
| Total mutations | operation-history.json | Count of writeFile, createFolder, renamePath, deletePath |
| Postcondition checks | events.jsonl | Count of `run.postcondition_completed` |
| Violation checks | events.jsonl | Count of `run.violations_checked` |
| Violations detected | events.jsonl | Count of `run.violation_detected` |

## Telemetry Engine

### `scripts/telemetry-report.js`

Reads all four ledger sources, computes metrics, and writes a markdown report.

```bash
node scripts/telemetry-report.js              # writes to data/telemetry-report.md
node scripts/telemetry-report.js /path/to/out.md # writes to custom path
```

The module exports `computeTelemetry()`, `generateMarkdownReport()`, and `detectProfile()` for programmatic use.

### Determinism Guarantee

```javascript
const t1 = computeTelemetry();
const t2 = computeTelemetry();
assert.deepStrictEqual(t1, t2); // always true for same ledger
```

All metrics are pure functions of the ledger. No external state, no randomness, no mutable counters.

## Report Format

The generated markdown report contains:

1. **Summary** — total runs, completed/failed/interrupted, averages
2. **Profile Metrics** — per-profile breakdown with success rates
3. **Failure Metrics** — violation counts, failure classifications
4. **Model Reliability** — per-model success rates and durations
5. **Terminalization Correctness** — execution_completed vs terminalized ratio
6. **Operational Pressure** — queue depth, recovery count, checkpoint restores
7. **Artifact Metrics** — writeFile counts, mutations, verification rates

## Invariants

1. `completed + failed + interrupted == terminalRuns`
2. `sum(profile.total) == terminalRuns`
3. `sum(profile.completed) == completedRuns`
4. `terminalizedCount <= executionCompletedCount`
5. `commitConflicts >= 0`
6. `phaseViolations >= 0`
7. All averages are rounded to 2 decimal places
8. Same ledger → identical report (deterministic)
9. No ledger mutation during telemetry computation (read-only)
