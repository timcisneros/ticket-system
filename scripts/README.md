# Scripts Inventory

All scripts live flat in this directory. Naming conventions:

- `*-test.js` — deterministic verification/regression scripts (`NODE_ENV=test`, exit nonzero on regression)
- `*-experiment.js` — one-off research experiments (observational; kept for provenance)
- `*-benchmark.js` — mocked-by-default benchmarks (see root README for real-model mode)
- `run-*.js` — investigation harnesses that drive full fixture corpora through the live server
- Everything else — operator CLI tools and maintenance utilities

Shared library modules (required by other scripts; **not** entrypoints — do not move or rename without updating dependents):

| Module | Dependents |
|---|---|
| `test-workspace.js` | 52 scripts (`createTempWorkspaceRoot` helper) |
| `replay-workspace.js` | 5 scripts |
| `projection-rebuilder.js` | 5 scripts (also a CLI) |
| `telemetry-report.js` | 2 scripts (also a CLI) |

## Operator CLI tools

- `oquery.js` — primary ticket CLI: login, create-ticket, query (see AGENTS.md "Preferred Ticket CLI Flow")
- `op-session.js` — interactive operator session helper
- `batch-tickets.js` — create tickets in bulk
- `ticket-lint.js` — lint ticket objectives before submission
- `codex-bootstrap.js` / `codex-trace.js` / `codex-verify.js` — orientation, single-run trace, deterministic health suite (`pnpm run codex:bootstrap|codex:trace|codex:verify`)
- `demo-legal-workflow.js` — end-to-end demo (`pnpm run demo:legal-workflow`)
- `postgres-migrate.js` — apply ordered shared-storage migrations (`DATABASE_URL=... pnpm run db:migrate`)

## Maintenance / forensics utilities

- `telemetry-report.js`, `pressure-report.js`, `pressure-suite.js` — operational telemetry and pressure reporting
- `projection-rebuilder.js`, `rebuild-runs-projection.js`, `rebuild-tickets-projection.js`, `projection-integrity-audit.js` — rebuild/audit JSON projections from `data/events.jsonl`
- `replay-export.js`, `replay-reconstructor.js`, `replay-verifier.js`, `extract-replay-snapshots.js` — replay snapshot tooling
- `recovery-verifier.js`, `resume-analyzer.js`, `event-chain-verify.js` — recovery and event-chain forensics
- `create-snapshot.js`, `verify-snapshot.js` — workspace snapshot tooling
- `auto-classify-failures.js` — failure classification per `docs/FAILURE_CLASSIFICATION_WORKFLOW.md`
- `harvest-benchmark-cases.js` — harvest failed runs into repair-benchmark fixtures (`pnpm run harvest:benchmark-cases`)
- `workload-validation-report.js` — workload validation reporting

## Fixture tooling

- `fixture-generator.js`, `fixture-verifier.js`, `fixture-evaluation.js`, `replay-fixture-generator.js`
- `expand-{vendor,support,legal-intake,shared-drive,shared-drive-v2}-fixture.js` — fixture corpus expanders (2026-06 evidence corpus)

## Verification (pnpm-wired)

`agent-regression-test`, `allocated-regression-test`, `allocated-live-openai-test`, `live-openai-test`, `recovery-regression-test`, `runtime-budget-test`, `postcondition-completion-test`, `workflow-composition-test`, `prefix-truncation-regression-test`, `tm3-replay-validation` (see `package.json` for the `test:*`/`validate:*` mappings). `codex-verify.js` additionally runs `catalog-consistency-test.js` and `page-render-regression-test.js`.

`postgres-persistence-contract-test.js` is provider-free and runs in the normal checkpoint.
`postgres-persistence-integration-test.js` requires `TEST_DATABASE_URL`; it creates and drops a
unique schema and is run against PostgreSQL by CI.

All other `*-test.js` files are targeted regression suites, run manually when the touched surface is relevant (AGENTS.md "Verification Workflow", step 7).

## v0.1.0 Internal Demo Release Checkpoint

Run the whole checkpoint with the single runner (`release-checkpoint.js` /
`pnpm run checkpoint:release`); it prints each command, runs them in order, and
stops on the first failure:

```sh
NODE_PATH=./node_modules node scripts/release-checkpoint.js
```

The runner executes this concise targeted set rather than every historical
investigation harness:

```sh
pnpm run build

NODE_PATH=./node_modules node scripts/catalog-consistency-test.js
NODE_PATH=./node_modules node scripts/page-render-regression-test.js
NODE_PATH=./node_modules node scripts/artifact-prediction-capture-test.js
NODE_PATH=./node_modules node scripts/ticket-feasibility-gate-test.js
NODE_PATH=./node_modules node scripts/moving-goalpost-regression-test.js
NODE_PATH=./node_modules node scripts/complete-flag-truncation-guard-test.js
NODE_PATH=./node_modules node scripts/direct-folder-postcondition-completeness-test.js
NODE_PATH=./node_modules node scripts/debug-reset-contamination-test.js
NODE_PATH=./node_modules node scripts/run-state-inconsistency-warning-test.js
NODE_PATH=./node_modules node scripts/run-detail-evidence-clarity-test.js
NODE_PATH=./node_modules node scripts/run-timeout-attribution-clarity-test.js
NODE_PATH=./node_modules node scripts/ticket-execution-state-clarity-test.js
NODE_PATH=./node_modules node scripts/health-live-paths-test.js
NODE_PATH=./node_modules node scripts/no-tracked-provider-keys-test.js
```

Several of these scripts start a local Fastify server on localhost and may need
normal port-binding permission in sandboxed environments.

## Investigation harnesses (2026-06 evidence corpus)

`run-customer-support-test`, `run-legal-intake-test`, `run-shared-drive-test`, `run-vendor-compliance-test`, `run-vendor-chunk-test`, `run-ticket-plan-test`, `run-er-validation`, `run-vc1-pipeline`, `recheck-er-cases`, `needs-arms-census`, `test-legal-impossibility`, `test-policy-gap-single`, `unverified-evaluation-test`, `verifier-contract-test`, `vendor-realism-benchmark` — harnesses behind the frozen evidence corpus in `ARCHIVE/evidence-corpus/`. Kept for provenance.

Closed-investigation leftovers kept in place for the same reason: `tm1-inspection-productivity-test.js`, `tm2-evidence-preservation-test.js` (siblings archived under `ARCHIVE/TM-ST-INVESTIGATIONS/`), and the five `er1*/er2*` error-recoverability probes.

## Report generators that write into docs/

- `operational-pressure-validation.js` → `docs/OPERATIONAL_PRESSURE_VALIDATION.md`
- `real-model-adversarial-validation.js` → `docs/REAL_MODEL_ADVERSARIAL_VALIDATION.md`

Past generated snapshots are preserved in `docs/archive/`; rerunning these scripts writes a fresh report to `docs/`.
