# Ticket System Operational Guide

## Purpose

This repository is a server-rendered ticketing system for bounded agent work. A ticket assigns
responsibility; a run is one admitted execution member. A singleton Ticket attempt contains one
Run, while one atomically admitted multi-Run wave is one Ticket attempt with exact immutable
membership. Agents may act directly or invoke an enabled workflow, but every action remains
subject to runtime authority, evidence, replay, recovery, evaluation, and consequence contracts.

## Runtime architecture

- Main app: `server.js` using Fastify and EJS.
- Structured runtime authority: PostgreSQL only, through `persistence/postgres/store.js` and
  all canonical migrations under `persistence/postgres/migrations/`.
- Runtime flow: ticket creation -> run admission/claim -> lease-fenced execution -> authority checks
  -> target operation -> transactional event/replay/receipt evidence -> evaluation/consequence.
- PostgreSQL owns sessions, catalogs, inbox/application state, runtime policy, leases, event chains,
  and inter-process coordination. No server JSON fallback or dual write exists.
- The filesystem is limited to the authorized execution workspace and replaceable browser
  artifacts. Root `data/` and `ARCHIVE/legacy-json-runtime/` are not live runtime stores.

## Core principles

- The repository is the sole source of truth. Nothing required to understand, operate, audit,
  recover, or continue this project may exist only in agent memory, chat context, scratchpads, or
  private notes. Open integrity defects, deferred work, and pending architectural decisions belong
  in `docs/ARCHITECTURAL_DECISIONS_PENDING.md` — the canonical register. A defect or decision
  discovered during work must be recorded there before the work ends, or the work must state
  explicitly that it was not recorded because repository scope was not authorized.
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
- Start bundled PostgreSQL with Docker or Podman Compose: `pnpm dev:db`
- Configure/migrate/bootstrap local development: `pnpm dev:setup`
- Diagnose local configuration without mutation: `pnpm dev:doctor`
- Start with read-only preflight: `pnpm dev`
- Verify the first real ticket/provider/workspace path: `pnpm dev:smoke`
- Rotate a user password through the audited repository: `pnpm admin:password`
- Apply migrations only: `pnpm db:migrate`
- All development commands load `.env.local`; explicit environment variables win
- Syntax: `npm run build`
- Orientation: `npm run developer-agent:bootstrap`
- Trace a run: `npm run developer-agent:trace -- --run <id>`
- Full gate: `TEST_DATABASE_URL=... npm run checkpoint:release`
- PG integration: `TEST_DATABASE_URL=... npm run test:persistence:postgres`
- Cutover boundary: `TEST_DATABASE_URL=... npm run test:cutover:postgres`

## Preferred CLI flow

```sh
node scripts/oquery.js login --url http://127.0.0.1:3099
node scripts/oquery.js agents --url http://127.0.0.1:3099
node scripts/oquery.js create-ticket --url http://127.0.0.1:3099 --agent 'Developer Agent' --wait --json '<objective>'
npm run developer-agent:trace -- --run <runId>
```

## Verification workflow

1. Run `npm run build`.
2. Targeted verification is the default: run the smallest registered verification set
   that covers the changed authority surface (focused deterministic suites for
   contract/docs-adjacent changes; the owning PostgreSQL integration suite for
   persistence/store surfaces).
3. A full canonical checkpoint (`TEST_DATABASE_URL=... npm run checkpoint:release`) is
   exceptional and required ONLY when a change crosses an explicit system-wide trust
   boundary:
   - canonical lifecycle semantics;
   - migration or release authority (including the tracked migration-execution
     authorization record);
   - cross-cutting canonical invariants, contracts, or registries (e.g.
     `scripts/test-manifest.js`, `scripts/release-checkpoint.js` owner lists);
   - the canonical checkpoint machinery itself;
   - an explicitly declared tranche/phase/release closure boundary.
4. A change outside those categories escalates to a full checkpoint only when
   deterministic evidence shows it can affect unrelated canonical owners or otherwise
   invalidates targeted verification.
5. Agents must not use vague judgments such as "important change", "large change", or
   "better safe than sorry" as independent reasons to require the full checkpoint.
   Documentation-only or narrow implementation changes do not automatically require it
   merely because they are committed or published.
6. The rule remains fail-closed wherever repository authority explicitly requires a full
   checkpoint (e.g. the governed migration-execution lifecycle and declared
   release/closure boundaries).
7. The full canonical checkpoint is a release/trust barrier, not the normal inner
   development loop.
8. For a failed run, inspect exact state, event chain, decision graph, replay, operation
   receipts, evaluation, and consequence before changing code.

## Operational boundaries

- New mutation work must not proceed unless its required evidence can be committed.
- Recoverable process admission pressure pauses/refuses new work and reopens automatically.
- PostgreSQL write, integrity, or ownership failures fail closed for the current process.
- Database transactions cannot include filesystem or external-provider effects. Prepared intent,
  stable operation keys, target idempotency, and reconciliation cover that boundary.
- Do not add ontology systems, broad plugin/orchestration layers, shell execution, or validation
  exceptions merely to make a benchmark pass.
