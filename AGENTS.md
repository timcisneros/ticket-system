# Ticket System Operational Guide

## Purpose

This repo is a server-rendered ticketing system for bounded agent work. A ticket assigns responsibility to an agent. An agent can act directly or invoke an enabled workflow capability. Actions mutate or inspect the workspace through the existing runtime authority, replay, recovery, event, evaluation, and consequence surfaces.

## Runtime Architecture

- Main app: `server.js` using Fastify, EJS views, and JSON file persistence.
- Runtime flow: ticket creation -> run creation/queueing -> lease acquisition -> agent or workflow execution -> action authority checks -> replay/events/logs/history -> postcondition and violation checks -> runEvaluation -> runConsequence -> UI/API state.
- Workflows are persisted JSON definitions in `data/workflows.json`. Workflow steps are an ordered `actions` array with deterministic branching through `next`, `trueNext`, and `falseNext`.
- Execution is single-process. JSON files remain the store. `data/events.jsonl` is append-only operational history; legacy JSON files still exist and are rewritten by current persistence helpers.
- PostgreSQL is the selected shared-storage target. Its core schema, optimistic lifecycle, evidence, replay, receipt, and concurrency primitives are implemented under `persistence/postgres/`. Scheduler-owned lease operations and complete run terminalization use asynchronous repository contracts with active JSON and tested PostgreSQL implementations. Ticket lifecycle/run creation remains the next cutover slice; the server runtime has not cut over and refuses a partial PostgreSQL mode. Follow `docs/POSTGRES_CUTOVER.md`; do not add JSON/PostgreSQL dual writes or a disposable-development-data importer.

## Core Principles

- Inspect evidence before changing code.
- Prefer deterministic checks over model judgment.
- Preserve raw runtime evidence in replay, events, logs, operation history, runEvaluation, and runConsequence.
- Keep mocked benchmarks strict and deterministic.
- Keep real-model benchmarks observational. Record failures honestly; do not manufacture passing results.
- Do not claim verification that was not run.

## Commands

- Start app: `pnpm run dev`
- Start app against tracked `data/`/`workspace-root` defaults: `pnpm start`
- Syntax check: `pnpm run build`
- Fast Codex orientation: `pnpm run codex:bootstrap`
- Trace one run: `pnpm run codex:trace -- --run <id>`
- Deterministic health suite: `pnpm run codex:verify`
- Workflow verification: `pnpm run test:workflow`
- Postcondition verification: `pnpm run test:postcondition`
- Endurance verification: `pnpm run benchmark:operational-endurance`
- Mocked draft benchmark: `pnpm run benchmark:workflow-drafts`
- Mocked repair benchmark: `pnpm run benchmark:workflow-repair`
- Mocked ambiguous benchmark: `pnpm run benchmark:ambiguous-operational`
- Real draft benchmark: `REAL_MODEL_BENCHMARK=1 pnpm run benchmark:workflow-drafts`
- Real repair benchmark: `REAL_MODEL_BENCHMARK=1 pnpm run benchmark:workflow-repair`
- Real ambiguous benchmark: `REAL_MODEL_BENCHMARK=1 pnpm run benchmark:ambiguous-operational`
- Schema teaching experiment: `pnpm run experiment:workflow-schema-teaching`
- Prefix truncation regression: `pnpm run test:truncation`
- TM-3 counterfactual replay: `pnpm run validate:truncation`
- PostgreSQL contract: `pnpm run test:persistence:contract`
- PostgreSQL integration: `TEST_DATABASE_URL=postgresql://... pnpm run test:persistence:postgres`
- Apply PostgreSQL migrations: `DATABASE_URL=postgresql://... pnpm run db:migrate`

## Internal Demo Release Baseline

- Proposed tag: `v0.1.0-internal-demo` after release docs are merged and a final checkpoint passes.
- Use `pnpm run dev` for local demo/dev runs. It sets `DATA_DIR=.local-data` and `WORKSPACE_ROOT=.local-workspace`, both ignored by Git.
- `data/*.json` files are tracked baseline/demo seed data. Runtime evidence includes events, logs, operation history, and replay snapshots.
- Provider configuration is environment-driven: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_MODEL`, and `OLLAMA_BASE_URL`. Keep secrets in ignored env files or the shell environment.
- Admin debug reset is a destructive local demo/dev reset, disabled in production. It is not production recovery.
- See `README.md` for first-demo setup, reset/rollback guidance, and the release checkpoint command list.

## Preferred Ticket CLI Flow

Use the project CLI for real ticket runs before reaching for ad hoc `curl` or direct JSON reads:

```bash
node scripts/oquery.js login --url http://127.0.0.1:3000
node scripts/oquery.js create-ticket --url http://127.0.0.1:3000 --agent Mike --wait --json "<objective>"
pnpm run codex:trace -- --run <runId>
```

Use `--agent <id|name>` for Agent 1, Mike, or another configured agent. Use `--json` so the returned `runId` can feed directly into `codex:trace`.

## Verification Workflow

1. Run `pnpm run build`.
2. Run `pnpm run test:workflow`.
3. Run `pnpm run test:postcondition`.
4. Run `pnpm run benchmark:operational-endurance`.
5. For UI/view changes, run `node scripts/page-render-regression-test.js`.
6. For catalog/action changes, run `node scripts/catalog-consistency-test.js`.
7. For broader runtime changes, add targeted existing regression scripts only when relevant.
8. For PostgreSQL persistence/coordination changes, run the contract test and the real integration test when a test database is available; CI always runs both the checkpoint contract and real PostgreSQL suite.

## Evidence Locations

- Tickets: `data/tickets.json`
- Runs: `data/runs.json`
- Append-only events: `data/events.jsonl`
- Logs: `data/logs.json`
- Operation history: `data/operation-history.json`
- Workflows: `data/workflows.json`
- Replay snapshots: `data/replay-snapshots/run-<id>.json`
- Real benchmark results: `data/benchmark-results.jsonl`
- Harvested repair cases: `data/benchmark-cases.jsonl`
- Workspace outputs: `workspace-root/`

## Failure Inspection Order

1. `pnpm run codex:trace -- --run <id>`
2. Inspect `data/replay-snapshots/run-<id>.json`.
3. Inspect run events with `/api/runs/:id/events` or `data/events.jsonl`.
4. Inspect `runEvaluation`, `runConsequence`, authority evidence, postconditions, and violations.
5. Inspect model responses and parsed actions.
6. Isolate model timeout or formatting from runtime validation.
7. Reproduce minimally.
8. Change code only after evidence points to a runtime bug.

## Operational Boundaries

- Do not add ontology systems, semantic graphs, policy DSLs, approval systems, plugin systems, visual builders, shell execution, or broad orchestration layers.
- Do not weaken validation to make benchmarks pass.
- Do not hardcode benchmark repairs into runtime behavior.
- Do not treat real-model failures as substrate failures without evidence.
- Do not rewrite unrelated user changes.

## Committing Alongside a Concurrent Agent

This repo sometimes has more than one agent/process working simultaneously (observed
2026-07-16/17: UI/transparency work and persistence-cutover work in parallel on the same
branch). When `git status` shows shared files (`server.js`, `scripts/oquery.js`,
`scripts/release-checkpoint.js`, `AGENTS.md`, …) modified by work that is not yours:

- **Never stage a shared file whole.** `git add <file>` commits the other agent's
  uncommitted work-in-progress under your commit message, corrupting both histories.
- Split by hunk instead: `git diff -U3 -- <file> > patch`, classify hunks by content
  markers unique to your change, write a yours-only patch, `git apply --cached` it.
- Before committing, validate the **staged blob**, not the working tree:
  `git show :<file> | node --check /dev/stdin` (plus any list/shape assertions that
  matter — the staged file is what the commit will contain).
- Stage whole files only when `git status` shows them untouched by the other effort.
- Place insertions (new sections, list entries) away from the other agent's pending
  hunks so both patch sets apply cleanly in either order.

## Current Known Reality

- Runtime substrate is functioning.
- `createWorkflowDraft` is visible in `allowedOperations` and runtime prompts.
- Outer action JSON can work with Mike/Ollama.
- Local `gemma3:latest` latency is high; the 5 second real benchmark runtime is too short for workflow drafting.
- Workflow schema generation quality is weak; one-shot examples did not produce a valid workflow through the full runtime path in the latest diagnostic.
- TM-3 Prefix Truncation is available behind `ENABLE_PREFIX_TRUNCATION=true` (default `false`). When enabled, exceeding the mutating action limit truncates the batch (keep non-mutating + first N mutating, drop the rest) instead of suppressing the entire batch. Safety validated for observed corpus patterns only (createFolder+writeFile, createFolder+independent renamePath, deletePath). Dependent mutation graphs **not validated**.
