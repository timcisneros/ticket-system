# Ticket System

## Workflow Benchmarks

Mocked mode is the default and is suitable for CI:

```sh
npm run benchmark:workflow-drafts
npm run benchmark:workflow-repair
```

Real-model mode disables mocked provider responses and uses a configured agent/provider normally. By default it tries agent `Mike`, or set `BENCHMARK_AGENT_NAME`:

```sh
REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-drafts
REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-repair
REAL_MODEL_BENCHMARK=1 npm run benchmark:ambiguous-operational
BENCHMARK_AGENT_NAME=Mike REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-drafts
```

Real-mode benchmark records are appended as JSONL to:

```txt
data/benchmark-results.jsonl
```

Real-mode failures are recorded with `passed:false` and `failureReason`; mocked mode still fails the process on regressions.

Harvest real failed workflow runs into future repair benchmark fixtures:

```sh
npm run harvest:benchmark-cases
```

Harvested cases are written to:

```txt
data/benchmark-cases.jsonl
```

The repair benchmark keeps synthetic fixtures by default. To include harvested cases as an evolving corpus:

```sh
INCLUDE_HARVESTED_BENCHMARK_CASES=1 npm run benchmark:workflow-repair
```
