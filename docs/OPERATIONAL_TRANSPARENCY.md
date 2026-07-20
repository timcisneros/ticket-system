# Operational Transparency

The operational transparency surface is read-only. `GET /api/ops/summary` and `/ops` derive a
bounded snapshot from PostgreSQL authority repositories plus process-local runtime metrics. Reading
the summary creates no ticket, run, event, log, receipt, or remediation action.

## Summary fields

- Ticket/run status counts come from database-maintained operational projections.
- Triage, Work Context, watcher, connector, routing-policy, template, and schedule counts come from
  their PostgreSQL repositories.
- Recent failure/refusal lists are bounded and deterministic.
- `mutationAdmission` reports process-local outstanding scopes/bytes, limits, utilization,
  high-water marks, and admission outcomes.

Mutation admission is not the deployment concurrency authority. PostgreSQL run claims enforce
`maxActiveRuns` and local-provider concurrency across server processes. Mutation admission protects
one process from excessive outstanding work before effects; pressure is recoverable and clears as
work drains.

## Warnings

Warnings identify state worth inspecting: unresolved triage, blocked tickets, failed runs,
connector/watcher refusals, missing control configuration, template-version inconsistency, or high
mutation-admission pressure. They are signals only; `/ops` provides no retry, reset, or mutation
controls.

## Event history browser

`/event-journal` and `/api/event-journal` expose a bounded, filtered, read-only window over the
append-only PostgreSQL event history. Run-scoped events include sequence, previous-hash, and hash
fields. The browser owns no ledger and cannot repair or mutate evidence.

## Scope

The surface reports what its repositories and current process can observe. It does not prove
external target materialization, cross-system exactly-once behavior, production database health, or
recording completeness beyond the enforced authority contracts.
