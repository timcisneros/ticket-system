# Structured Allocation — Scored Fixture Evaluation v2, Protocol v1

**SCORED FIXTURE EVIDENCE.** Deterministic fixture trials only. No
live-model trial contributed to any number below.

| | |
|---|---|
| Protocol | structured-allocation-controlled-evaluation v1 |
| Manifest hash | `3521079e6924abd2d546bad2a6a5bfda342b9d64f1578675af6a52a35a43d490` |
| Scored-run hash | `0529783aac957828ec6f012d3131d681f7f5a986d67e2cf113bae324d6be4a2e` |
| Repository commit | `ca2cd188a6e10a41eb4bd36ee7eb10504b41978c` |
| Corpus hash | `be18c7e405efabedf135b5d88c46cbca207446093fc1fbbf60c25852b6769324` |
| Trials | 200 |
| Exclusions | 0 |
| Report hash | `24b672e6946aab780eb0662bbaacbe698e66b36f9ec0dbe07c38b5448dd5df22` |

**Corpus integrity:** SCORED FIXTURE CORPUS COMPLETE AND INTERNALLY CONSISTENT

## Metrics by arm

Arms are never collapsed: A2a/A2b and B/C stay separate so the evidence
can distinguish legacy parallelism from structured machinery, and
allocated from dynamic ownership.

| Arm | Trials | Allocation quality | True completion | FALSE completion | Oracle refused | Latency (ms) | Normalized cost | Churn windows |
|---|---|---|---|---|---|---|---|---|
| A | 40 | 100.0% | 0.0% | 0.0% | 12.5% | 2393 | 5196.88 | n/a |
| A2a | 40 | 100.0% | 0.0% | 0.0% | 12.5% | 2791 | 25625.88 | n/a |
| A2b | 20 | 100.0% | 0.0% | 0.0% | 25.0% | 2337 | 20567.75 | n/a |
| B | 60 | 100.0% | 0.0% | 0.0% | 8.3% | 4170 | 40415.48 | 0.00 |
| C | 40 | 100.0% | 0.0% | 0.0% | 12.5% | 2973 | 46197.00 | 0.00 |

## Hard disqualifiers

Evaluated BEFORE any ordinary tradeoff. None was added, waived or
reworded after seeing which arm triggered it.

- **NOT TRIGGERED** — structured false-positive completion rate higher than arm A on any family
- **NOT TRIGGERED** — any authority violation (fabricated block or completion authority, completion without canonical decision, cross-projection disagreement)
- **NOT TRIGGERED** — uncontrolled cost (settled spend beyond the captured economic ceiling, or unbounded growth across repetitions)
- **NOT EVALUABLE** — non-deterministic recovery (identical durable state producing different terminal dispositions)
- **NOT TRIGGERED** — systematic churn misclassification (persistence or recovery interruption attributed to model churn)

## Frozen decision

**FIXTURE EVIDENCE SUPPORTS STOP**

Basis: no hard disqualifier, but structured does not improve truthful completion by at least 5 points over BOTH A and A2

- structured true-completion gain versus A: 0.0 points
- structured true-completion gain versus A2: 0.0 points

**FINAL PRODUCT DECISION: REQUIRES LIVE-MODEL MATRIX**

## Metrics by scenario family

### family-3

| Arm | Trials | Allocation quality | True completion | FALSE completion |
|---|---|---|---|---|
| A | 5 | 100.0% | 0.0% | 0.0% |
| A2a | 5 | 100.0% | 0.0% | 0.0% |
| A2b | 5 | 100.0% | 0.0% | 0.0% |
| B | 5 | 100.0% | 0.0% | 0.0% |
| C | 5 | 100.0% | 0.0% | 0.0% |

### family-4

| Arm | Trials | Allocation quality | True completion | FALSE completion |
|---|---|---|---|---|
| A | 5 | 100.0% | 0.0% | 0.0% |
| A2a | 5 | 100.0% | 0.0% | 0.0% |
| A2b | 5 | 100.0% | 0.0% | 0.0% |
| B | 5 | 100.0% | 0.0% | 0.0% |
| C | 5 | 100.0% | 0.0% | 0.0% |

### family-7

| Arm | Trials | Allocation quality | True completion | FALSE completion |
|---|---|---|---|---|
| B | 20 | 100.0% | 0.0% | 0.0% |
| C | 20 | 100.0% | 0.0% | 0.0% |

### family-8

| Arm | Trials | Allocation quality | True completion | FALSE completion |
|---|---|---|---|---|
| A | 20 | 100.0% | 0.0% | 0.0% |
| A2a | 20 | 100.0% | 0.0% | 0.0% |
| B | 20 | 100.0% | 0.0% | 0.0% |

### family-9

| Arm | Trials | Allocation quality | True completion | FALSE completion |
|---|---|---|---|---|
| A | 10 | 100.0% | 0.0% | 0.0% |
| A2a | 10 | 100.0% | 0.0% | 0.0% |
| A2b | 10 | 100.0% | 0.0% | 0.0% |
| B | 10 | 100.0% | 0.0% | 0.0% |
| C | 10 | 100.0% | 0.0% | 0.0% |

