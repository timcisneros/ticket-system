# Operator Inbox

The inbox at `/inbox` is the messaging surface where work that needs a human finishes: blockers arrive as message threads and completed tickets deliver their results as message threads. It replaced the read-only `/triage` table (that path now redirects) and the inline triage-resolve forms that previously lived on the ticket and run detail pages — those pages are read-only for triage and link into the inbox thread instead. The inbox is the only surface that resolves triage.

## Why it exists

Before the inbox, a ticket always terminated silently: the operator had to open the tickets page, find the ticket, open the run, and reconstruct what happened. Now the agent's outcome — what went wrong, what needs clarification, or what was delivered — arrives as a message the operator can read and answer in one place.

## Message authorship contract (do not violate)

**Never fabricate agent prose.** A message attributed to an agent must be the model's own recorded output, verbatim:

- Blocker threads for runs use the model's final response message from the replay snapshot (`getRunLatestParsedPlanMessage`), falling back to `browserReportMessage` for browser runs.
- Deliverable threads use the model's final report message the same way.
- When no model output exists (pre-run gates such as objective ambiguity, feasibility, or routing; failures before any model response), the thread carries a **system**-attributed message whose body is the recorded gate/failure text (`triage.summary`) — factual, and never dressed up as the agent speaking.
- Structured triage facts (reasonCode, requiredDecision, allowed/prohibited actions, evidenceRefs) are stored as thread metadata and rendered by the UI as a facts panel. They are not serialized into message prose.

Planned evolution: a runtime operation that lets the model send inbox messages directly during a run, so messages come from the model at the moment it is blocked rather than being extracted from terminal evidence afterwards.

## Known asymmetry: the channel is one-way (audited 2026-07-17)

The agent's words reach the operator; the operator's words do not reach the agent. A triage
resolution note is an annotation on the triage record — nothing injects it (or thread replies)
into the rerun's context, so a rerun starts from objective + assignment with no knowledge of
what the operator said about the previous attempt. There is also no mid-run channel in either
direction. Closing this is a design decision, not a bug fix: feeding operator prose into a
bounded prompt has prompt-injection and boundedness implications, and per
`decision-memo-objective-interpretation-direction.md` an operator-confirmed instruction is
`human_confirmed`-source input with real authority — it deserves a decision memo before
implementation.

## Data model

`data/message-threads.json` — one record per thread:

- `key` — idempotency key: `ticket:<id>:triage:<createdAt>`, `run:<id>:triage:<createdAt>`, or `ticket:<id>:deliverable:run:<runId>`. A rerun that produces new triage gets a new key, hence a new thread (email semantics).
- `kind` — `blocker` (needs an operator decision) or `deliverable` (needs acknowledgement).
- `ticketId`, `runId`, `workContextId` — navigation and filtering.
- `status` — `open`/`closed`, plus `closedAt`/`closedBy`.
- Triage facts (blockers): `reasonCode`, `requiredDecision`, `summary`, `allowedActions`, `prohibitedActions`, `evidenceRefs`.
- `messages[]` — `{ id, author: agent|system|operator, authorName, kind: report|reply|resolution|acknowledgement, body, createdAt }`.

## Reconciler

`reconcileInboxThreads()` (server.js) derives threads from authoritative ticket/run state on every inbox read. It is idempotent, never mutates tickets or runs, and covers **every** triage-creation path (feasibility, objective ambiguity, model routing, run failure/interruption) without per-path hooks. Completed tickets produce a deliverable thread keyed to their final completed run. Triage resolved outside the inbox (legacy API, scripts) is mirrored into the matching thread as a resolution message that closes it. Triage that was already resolved before any thread existed is not backfilled.

## Responding

- **Reply** (`POST /api/inbox/threads/:id/reply`) — appends an operator note; thread stays open.
- **Reply & Resolve** (`POST /api/inbox/threads/:id/resolve`, blocker threads) — the reply body becomes the triage resolution note via the same annotation semantics as the legacy endpoints (`applyTicketTriageResolution`/`applyRunTriageResolution`): triage is marked resolved, nothing is rerun or completed, and the ticket's rerun gates reopen.
- **Acknowledge & Close** (same endpoint, deliverable threads) — records receipt and closes the thread.

The legacy `POST /api/tickets/:id/triage/resolve` and `POST /api/runs/:id/triage/resolve` endpoints remain for scripts/CLI (`oquery`) and mirror their resolutions into the thread.

## Permissions and audit

- View: `ticket:read` (page and `GET /api/inbox/threads`; optional `?workContextId=` filter — unfiltered view never hides uncontexted triage).
- Respond/resolve: `ticket:update`.
- System log types: `inbox:reply`, `inbox:deliverable_acknowledged`, plus the existing `ticket:triage_resolve`/`run:triage_resolve` from resolution.

## Tests

- `pnpm run test:inbox` (`scripts/inbox-messaging-test.js`) — end-to-end messaging semantics: verbatim attribution, reply/resolve/acknowledge, legacy-API mirroring, audit entries.
- `scripts/triage-inbox-test.js` — visibility, permission gating, no-mutation-on-read, `/triage` redirect.
- `scripts/triage-resolution-test.js` — the resolution annotation contract (annotate only; no rerun/completion/status change).
