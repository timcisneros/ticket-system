# Operational Telemetry Report

Generated: 2026-05-28T03:12:13.586Z
Data source: ledger evidence (events.jsonl, runs.json, tickets.json, operation-history.json)

## Summary

| Metric | Value |
|--------|-------|
| Total runs | 68 |
| Terminal runs | 68 |
| Completed | 29 |
| Failed | 33 |
| Interrupted | 6 |
| Avg execution steps | 1.4 |
| Avg model requests | 1.9 |
| Avg workspace operations | 2.19 |
| Avg mutations | 0.74 |
| Avg duration (ms) | 62440 |
| Retry runs | 0 |
| Reassess runs | 0 |
| Tickets with reruns | 0 |

## Profile Metrics

| Profile | Total | Completed | Failed | Success Rate | Avg Steps | Avg Model Requests | Avg Workspace Ops |
|---------|-------|-----------|--------|--------------|-----------|-------------------|-------------------|
| other | 42 | 15 | 23 | 36% | 1.07 | 1.67 | 1.6 |
| report | 16 | 9 | 5 | 56% | 1.81 | 2.19 | 3.5 |
| diagnosis | 4 | 3 | 1 | 75% | 1.5 | 1.75 | 1.75 |
| refactor | 3 | 1 | 2 | 33% | 3.33 | 3.67 | 3.67 |
| recommendation | 2 | 1 | 1 | 50% | 1.5 | 2 | 2 |
| bulk-inventory | 1 | 0 | 1 | 0% | 2 | 2 | 4 |

## Failure Metrics

| Metric | Count |
|--------|-------|
| Phase violations | 1 |
| Authority denials | 0 |
| Action suppressed | 1 |
| Commit conflicts | 0 |
| Non-progress loops | 0 |
| Limit exhaustion | 23 |
| OOM failures | 8 |
| Model failures | 4 |

### Failure Classifications

| Kind | Count |
|------|-------|
| timeout | 17 |
| provider_error | 8 |
| interrupted | 6 |
| budget_exhausted | 4 |
| no_progress | 2 |
| protected_path | 1 |
| workspace_error | 1 |

## Model Reliability

| Model | Total | Completed | Failed | Success Rate | Avg Duration (ms) |
|-------|-------|-----------|--------|--------------|-------------------|
| gemma3:latest | 37 | 12 | 25 | 32% | 81394 |
| gpt-4.1-mini | 25 | 17 | 8 | 68% | 18048 |
| deepseek-r1:latest | 6 | 0 | 6 | 0% | 130528 |

## Terminalization Correctness

| Metric | Value |
|--------|-------|
| execution_completed events | 9 |
| terminalized events | 9 |
| Correctness ratio | 100% |

## Operational Pressure

| Metric | Value |
|--------|-------|
| Max queue depth | 4 |
| Avg queue depth | 0 |
| Runs started | 10 |
| Recovery events | 0 |
| Lease expired | 1 |
| Checkpoint restores | 10 |

## Artifact Metrics

| Metric | Value |
|--------|-------|
| Total writeFile operations | 31 |
| Report artifacts (.md, .txt, .rst) | 31 |
| Total mutations | 56 |
| Postcondition checks | 0 |
| Violation checks | 10 |
| Violations detected | 0 |
