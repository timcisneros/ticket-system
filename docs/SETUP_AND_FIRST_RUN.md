# Setup and First Run

A practical first-run walkthrough. Where the repo's exact behavior matters, this guide says to
verify from code/UI rather than assume.

## 1. Prerequisites

- Node.js 24 and pnpm 11.8.0 through Corepack. The app is a single-process Fastify server
  backed by JSON files.
- No external services are required for the demo path. Running **live agents** additionally needs a
  configured provider (OpenAI API key, or a local Ollama).

## 2. Install dependencies

```sh
corepack enable
pnpm install --frozen-lockfile
```

## 3. Environment variables

The server reads `.env` via `dotenv` (`.env`, `.env.local`, `.env.test.local` are Git-ignored). Core
variables (see README → Configuration for the full list):

- `PORT` (default `3099`), `NODE_ENV` (`development` via `npm run dev`).
- `DATA_DIR` (JSON store; demo/dev uses ignored `.local-data`), `WORKSPACE_ROOT` (mutation target;
  demo/dev uses ignored `.local-workspace`).
- `ADMIN_BOOTSTRAP_PASSWORD` (bootstrap admin password), `SESSION_SECRET` (random for the current
  process if omitted), and optional `PUBLIC_BASE_URL` for exact-origin request checks.
- Provider (optional, only for live agents): `OPENAI_API_KEY` / `OPENAI_MODEL`, or `OLLAMA_MODEL` /
  `OLLAMA_BASE_URL`.
- Process-local event append admission and batching (optional): `EVENT_JOURNAL_MAX_RECORD_BYTES`,
  `EVENT_JOURNAL_MAX_BATCH_ENTRIES`, `EVENT_JOURNAL_MAX_BATCH_BYTES`,
  `EVENT_JOURNAL_MAX_OUTSTANDING_ENTRIES`, and `EVENT_JOURNAL_MAX_OUTSTANDING_BYTES`. Values must
  be positive integers; record capacity must be at least 1024 bytes and cannot exceed batch or
  outstanding-byte capacity. Invalid values fail startup instead of silently falling back. Current
  pressure, weighted record/byte reservations, worst-case mutation-scope capacity, high-water
  marks, rejection counts, and the effective configuration are visible at `/ops` and
  `GET /api/runtime/status`. These settings do not cap or rotate the total `events.jsonl` file.

There is no `.env.example`; set variables in your shell or an ignored `.env`.

## 4. Start the app

```sh
npm run dev     # development; serves http://localhost:3099 against .local-data / .local-workspace
```

The app prints the selected `DATA_DIR`, `WORKSPACE_ROOT`, and URL at startup. (For a no-provider-key
tour: `npm run demo:seed` then `npm run demo:dev`.)

## 5. Login / seed assumptions

The bootstrap admin (`admin` / `admin123`, or `ADMIN_BOOTSTRAP_PASSWORD`) is created **only when an
admin user is missing**. A fresh `.local-data` store is seeded from tracked demo data, so example
agents may exist — they carry **no provider keys**. Verify the exact seeded accounts in your store
(Admin UI or `node scripts/oquery.js agents`) rather than assuming.

## 6. Create or inspect a ticket

In the UI: create a ticket assigned to an agent (e.g. objective `Create a folder named demo and
stop.`). Headless: `node scripts/oquery.js create-ticket --agent <name-or-id> --wait --json "<objective>"`.
Inspect at `/tickets` and `/tickets/:id`.

## 7. Run or inspect a run

Runs are created through the normal path. Open `/runs/:id` (or `oquery runs`) to see status,
provider/model counts, workspace actions, replay events, logs, and why a run stopped. Live execution
requires a configured provider; without one, the run fails clearly ("Agent API key is missing").

## 8. View timeline / evidence

Open the ticket-detail **Timeline** section or `GET /api/tickets/:id/timeline` (needs `ticket:read`).
Evidence lives in `data/events.jsonl`, `data/operation-history.json`, and `data/replay-snapshots/`.

## 9. Use triage

Open `/triage` to review unresolved ticket/run triage (blocked, verification-failed, ambiguous).
Resolving annotates only — it does not rerun or change status.

## 10. Inspect Work Contexts

`/work-contexts` (needs `workContext:manage`): list, detail, and per-context filtered links. Summary
API: `GET /api/work-contexts/:id/summary`.

## 11. Inspect watchers

`/watchers` (needs `watcher:manage`): list/detail. Observe via `POST /api/watchers/:id/observe`
(manual). Draft proposals via `POST /api/watchers/:id/proposals`; approve (creates a normal ticket)
via `POST /api/watcher-proposals/:id/approve` (needs `ticket:create`).

## 12. Inspect model routing

`/model-routing-policies` (needs `modelRouting:manage`): list/detail. New runs carry a
`routingSnapshot`; development data should be reset when the run schema changes.

## 13. Inspect connectors

`/connectors` (needs `connector:manage`): list/detail. Read a bounded object via
`POST /api/connectors/:id/read` (needs `connector:read`). Writes are refused
(`POST /api/connectors/:id/write` → `write_disabled_in_r1.30`).

## 14. Inspect operational transparency

`/ops` or `GET /api/ops/summary` (needs `ops:read`): counts, warning flags, recent failures/refusals,
and links. Read-only.

## 15. Run release checkpoint

```sh
npm run checkpoint:release
```

Provider-free, network-free, and deterministic; it reports the executed and passing check count.
See `docs/RELEASE_CHECKPOINT.md`.

## 16. Common local issues

- **Port in use** — set `PORT`.
- **Local model slow / protocol non-compliance** — small Ollama models may not follow the agent
  protocol; prefer a stronger configured provider for a dependable green run.
- **`data/events.jsonl` removed after a pull** — expected (untracked transition); the app recreates
  an empty one. Restore old contents deliberately if needed (README → Event log lifecycle).
- **Permission denied on a surface** — the logged-in user lacks the gating permission (e.g.
  `workContext:manage`, `connector:manage`, `ops:read`); adjust the user's group permissions.
- **A checkpoint test fails** — read the printed failing command; the checkpoint stops on the first
  failure and never swallows it.
