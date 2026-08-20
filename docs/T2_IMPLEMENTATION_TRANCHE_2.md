# T2 Implementation Tranche 2

## Durable Cancellation Authority Substrate

Tranche 2 establishes a durable Ticket-owned cancellation authority without
performing the historical six-state to five-state migration. The authority is
the canonical fact that intentional abandonment occurred; the append-only
`ticket.cancellation_committed` event is provenance only.

## Established

- Migration `040_ticket_cancellation_authority.sql` adds nullable
  `tickets.cancellation_authority` JSONB.
- PostgreSQL validates the exact six-key authority shape with a NULL-safe
  PL/pgSQL CHECK helper: missing/null fields, wrong JSON scalar types, wrong
  Ticket binding, unsupported versions, extra keys and impossible
  ISO-shaped timestamps are all false at the database boundary. The timestamp
  is parsed as `timestamptz`, matching runtime Date validation.
- A PostgreSQL trigger rejects any update or delete-like replacement after the
  authority is committed. The authority is write-once and immutable.
- `runtime/ticket-cancellation-authority-contract.js` owns the normalized,
  versioned authority shape and semantic-repeat comparison.
- `PostgresRuntimeStore.cancelTicket` acquires the proven Tranche 1 lock order:
  allocation plan, attempt members ordered by Run ID, current attempt, then
  Ticket. It revalidates the routed attempt after those locks.
- Cancellation uses the shared Tranche 1 attempt completion evaluator and the
  shared v2 completion evaluator. Completion that is already inevitable,
  terminal v2 conflicts, malformed v2 authority, completed Tickets and
  historical `closed` Tickets refuse cancellation.
- Exact semantic cancellation repeats return the committed authority without a
  second event. Changed authority inputs are refused.
- Committed cancellation authority blocks generic Ticket transitions, reopen,
  plan/leaf admission and Run admission. Settlement observes the authority and
  cannot replace it.
- `projectTicketLifecycle` reports `canceled` from the durable authority.

## Intentionally Deferred

The current database CHECK constraints and runtime status counts accept the
historical vocabulary `open`, `in_progress`, `completed`, `failed`, `blocked`,
and `closed`; they do not accept `canceled`. This tranche therefore does not
write `tickets.status = 'canceled'`. Materialized canceled status remains part
of the later atomic five-state cutover. Existing `closed` rows are not
reinterpreted and do not acquire cancellation authority.

## Falsification

`scripts/t2-cancellation-authority-postgres-test.js` covers direct SQL
malformed-shape rejection for every required field and extra-key case, valid
first write plus rewrite refusal, cancellation before completion, a
pre-existing completion race, forced cancellation-first and completion-first
orderings, an actual not-yet-inevitable writer race, idempotence,
admission/reopen refusal, Run-only cancellation-shaped evidence, stale v2
completion inevitability and malformed v2 fail-closed behavior. It passes with
76 assertions. The pure authority contract passes with 10 assertions.

The concurrency truths are distinct. When completion is already durable before
the writers race, cancellation refuses regardless of scheduling and settlement
retains `COMPLETED`. When completion is not inevitable at the serialization
point, cancellation-first commits cancellation and blocks later settlement;
completion-first commits `COMPLETED` and cancellation refuses. The actual race
accepts only those two paired causes and inspects every Promise result.

No public HTTP/API/UI/CLI status cutover, blocker supersession, historical
migration, uncancel/reopen semantics, or provider behavior is included. Public
cancellation activation and active-Run interruption/recovery integration remain
prerequisites before cancellation is exposed as final product behavior; this
tranche establishes the durable authority substrate only.
