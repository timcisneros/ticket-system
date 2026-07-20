# Ticket System Operational Guide

## Purpose

This repository is a server-rendered ticketing system for bounded agent work. A ticket assigns
responsibility; a run is one execution attempt. Agents may act directly or invoke an enabled
workflow, but every action remains subject to runtime authority, evidence, replay, recovery,
evaluation, and consequence contracts.

## Runtime architecture

- Main app: `server.js` using Fastify and EJS.
- Structured runtime authority: PostgreSQL only, through `persistence/postgres/store.js` and
  migrations `persistence/postgres/migrations/001_*.sql` through `028_*.sql`.
- Runtime flow: ticket creation -> run admission/claim -> lease-fenced execution -> authority checks
  -> target operation -> transactional event/replay/receipt evidence -> evaluation/consequence.
- PostgreSQL owns sessions, catalogs, inbox/application state, runtime policy, leases, event chains,
  and inter-process coordination. No server JSON fallback or dual write exists.
- The filesystem is limited to the authorized execution workspace and replaceable browser
  artifacts. Root `data/` and `ARCHIVE/legacy-json-runtime/` are not live runtime stores.

## Core principles

- Inspect evidence before changing code.
- Prefer deterministic checks over model judgment.
- Preserve raw runtime evidence in events, replay, logs, operation receipts, evaluation, and
  consequence records.
- Keep mocked checks strict and deterministic; report real-model failures honestly.
- Do not claim verification that was not run.
- Do not add a legacy compatibility path for disposable development data without explicit product
  value.
- Do not rewrite unrelated or concurrent user changes.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Configure/migrate/bootstrap local development: `pnpm dev:setup`
- Diagnose local configuration without mutation: `pnpm dev:doctor`
- Start with read-only preflight: `pnpm dev`
- Verify the first real ticket/provider/workspace path: `pnpm dev:smoke`
- Rotate a user password through the audited repository: `pnpm admin:password`
- Apply migrations only: `pnpm db:migrate`
- All development commands load `.env.local`; explicit environment variables win
- Syntax: `npm run build`
- Orientation: `npm run codex:bootstrap`
- Trace a run: `npm run codex:trace -- --run <id>`
- Full gate: `TEST_DATABASE_URL=... npm run checkpoint:release`
- PG integration: `TEST_DATABASE_URL=... npm run test:persistence:postgres`
- Cutover boundary: `TEST_DATABASE_URL=... npm run test:cutover:postgres`

## Preferred CLI flow

```sh
node scripts/oquery.js login --url http://127.0.0.1:3099
node scripts/oquery.js agents --url http://127.0.0.1:3099
node scripts/oquery.js create-ticket --url http://127.0.0.1:3099 --agent 'Developer Agent' --wait --json '<objective>'
npm run codex:trace -- --run <runId>
```

## Verification workflow

1. Run `npm run build`.
2. Run `TEST_DATABASE_URL=... npm run checkpoint:release` for runtime or persistence changes.
3. Run a focused regression script when a changed surface is not in the checkpoint.
4. For a failed run, inspect exact state, event chain, decision graph, replay, operation receipts,
   evaluation, and consequence before changing code.

## Operational boundaries

- New mutation work must not proceed unless its required evidence can be committed.
- Recoverable process admission pressure pauses/refuses new work and reopens automatically.
- PostgreSQL write, integrity, or ownership failures fail closed for the current process.
- Database transactions cannot include filesystem or external-provider effects. Prepared intent,
  stable operation keys, target idempotency, and reconciliation cover that boundary.
- Do not add ontology systems, broad plugin/orchestration layers, shell execution, or validation
  exceptions merely to make a benchmark pass.
