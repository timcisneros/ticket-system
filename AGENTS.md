# Ticket System Operational Guide

## Purpose

This repo is a server-rendered ticketing system for bounded agent work. A ticket assigns responsibility to an agent. An agent can act directly or invoke an enabled workflow capability. Actions mutate or inspect the workspace through the existing runtime authority, replay, recovery, event, evaluation, and consequence surfaces.

## Runtime Architecture

- Main app: `server.js` using Fastify, EJS views, and JSON file persistence.
- Runtime flow: ticket creation -> run creation/queueing -> lease acquisition -> agent or workflow execution -> action authority checks -> replay/events/logs/history -> postcondition and violation checks -> runEvaluation -> runConsequence -> UI/API state.
- Workflows are persisted JSON definitions in `data/workflows.json`. Workflow steps are an ordered `actions` array with deterministic branching through `next`, `trueNext`, and `falseNext`.
- Execution is single-process. JSON files remain the store. `data/events.jsonl` is append-only operational history; legacy JSON files still exist and are rewritten by current persistence helpers.

## Core Principles

- Inspect evidence before changing code.
- Prefer deterministic checks over model judgment.
- Preserve raw runtime evidence in replay, events, logs, operation history, runEvaluation, and runConsequence.
- Keep mocked benchmarks strict and deterministic.
- Keep real-model benchmarks observational. Record failures honestly; do not manufacture passing results.
- Do not claim verification that was not run.

## Commands

- Start app: `npm run dev`
- Syntax check: `npm run build`
- Fast Codex orientation: `npm run codex:bootstrap`
- Trace one run: `npm run codex:trace -- --run <id>`
- Deterministic health suite: `npm run codex:verify`
- Workflow verification: `npm run test:workflow`
- Postcondition verification: `npm run test:postcondition`
- Endurance verification: `npm run benchmark:operational-endurance`
- Mocked draft benchmark: `npm run benchmark:workflow-drafts`
- Mocked repair benchmark: `npm run benchmark:workflow-repair`
- Mocked ambiguous benchmark: `npm run benchmark:ambiguous-operational`
- Real draft benchmark: `REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-drafts`
- Real repair benchmark: `REAL_MODEL_BENCHMARK=1 npm run benchmark:workflow-repair`
- Real ambiguous benchmark: `REAL_MODEL_BENCHMARK=1 npm run benchmark:ambiguous-operational`
- Schema teaching experiment: `npm run experiment:workflow-schema-teaching`
- Prefix truncation regression: `npm run test:truncation`
- TM-3 counterfactual replay: `npm run validate:truncation`

## Preferred Ticket CLI Flow

Use the project CLI for real ticket runs before reaching for ad hoc `curl` or direct JSON reads:

```bash
node scripts/oquery.js login --url http://127.0.0.1:3000
node scripts/oquery.js create-ticket --url http://127.0.0.1:3000 --agent Mike --wait --json "<objective>"
npm run codex:trace -- --run <runId>
```

Use `--agent <id|name>` for Agent 1, Mike, or another configured agent. Use `--json` so the returned `runId` can feed directly into `codex:trace`.

## Verification Workflow

1. Run `npm run build`.
2. Run `npm run test:workflow`.
3. Run `npm run test:postcondition`.
4. Run `npm run benchmark:operational-endurance`.
5. For UI/view changes, run `node scripts/page-render-regression-test.js`.
6. For catalog/action changes, run `node scripts/catalog-consistency-test.js`.
7. For broader runtime changes, add targeted existing regression scripts only when relevant.

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

1. `npm run codex:trace -- --run <id>`
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

## Current Known Reality

- Runtime substrate is functioning.
- `createWorkflowDraft` is visible in `allowedOperations` and runtime prompts.
- Outer action JSON can work with Mike/Ollama.
- Local `gemma3:latest` latency is high; the 5 second real benchmark runtime is too short for workflow drafting.
- Workflow schema generation quality is weak; one-shot examples did not produce a valid workflow through the full runtime path in the latest diagnostic.
- TM-3 Prefix Truncation is available behind `ENABLE_PREFIX_TRUNCATION=true` (default `false`). When enabled, exceeding the mutating action limit truncates the batch (keep non-mutating + first N mutating, drop the rest) instead of suppressing the entire batch. Safety validated for observed corpus patterns only (createFolder+writeFile, createFolder+independent renamePath, deletePath). Dependent mutation graphs **not validated**.
