# Ticket System

## Documentation Map

**Canonical docs** (live, describe the current system — left in place):

- `AGENTS.md` — operational guide: commands, verification workflow, evidence locations, boundaries
- Root operations canon: `OPERATIONS.md`, `OPERATOR_CONTRACT.md`, `OPERATIONAL_PRESSURES.md`, `DIRECTION.md`, `STRATEGY.md`, `STATE_SURFACES.md`
- `docs/` — system semantics and contracts, e.g. `ARCHITECTURE_INVARIANTS.md`, `EXECUTION_MODEL.md`, `EXECUTION_PHASES.md`, `EXECUTION_SEMANTICS.md`, `BOUNDED_OPERATION_BATCHES.md`, `LIFECYCLE_EVENTS.md`, `WORKLOAD_PROFILES.md`, `OPERATIONAL_TELEMETRY.md`, `FAILURE_TAXONOMY.md`, `FAILURE_CLASSIFICATION_WORKFLOW.md`, `DECISION_LOG.md`, `KNOWN_LIMITATIONS.md`, `BUSINESS_FIXTURE_SPEC.md`, `PRODUCT_SYNTHESIS.md`
- Root evidence corpus (active research, 2026-06): `evidence-ledger.md`, `evidence-consolidation.md`, `failure-cluster-report.md`, `anchored-summary.md`, `evidence-memo.md`, `evidence-reconciliation-validation.md`

**Archived docs**: closed investigations, superseded plans, generated validation
reports, and early exploratory documents live in `docs/archive/` (see its README
for the index). Frozen investigation evidence bundles (data + harnesses) live in
`ARCHIVE/` (see its README).

**Scripts inventory**: `scripts/README.md` categorizes all scripts (operator CLI,
maintenance utilities, verification, benchmarks, experiments, investigation
harnesses) and lists the shared modules other scripts depend on.

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

Slow local real-model benchmarks require configurable timeout budgets. Short benchmark defaults are suitable for fast CI, but they are not evidence of model or runtime failure when evaluating slow local models. Use explicit timeout overrides such as `BENCHMARK_AGENT_RUNTIME_MS` and `BENCHMARK_RUN_WAIT_TIMEOUT_MS` when running observational real-model benchmarks.

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
