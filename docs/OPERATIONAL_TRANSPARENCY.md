# Operational Transparency

The operational transparency surface is read-only. `GET /api/ops/summary` and `/ops` derive a
bounded snapshot from PostgreSQL authority repositories plus process-local runtime metrics. Reading
the summary creates no ticket, run, event, log, receipt, or remediation action.

## Health semantics (P6-S2)

`/health` and `/api/health` (the public API health route) expose the same frozen health contract:

- `alive` — the process exists and can answer. Liveness never depends on PostgreSQL, migration
  state, providers, or work capacity; a process that cannot answer at all shows as the usual
  connection-level liveness failure. These routes are readiness observation surfaces, not
  liveness gate probes: an operator observing liveness does so at the connection level — the
  process answering any request at all (or the listening TCP endpoint) — exactly as the P6
  design freeze's "liveness remains dependency-free" semantic is observed operationally. Both
  readiness routes keep response latency bounded by the designed probe timeout; they never
  wait indefinitely on any dependency.
- `ready` — the process may safely receive normal application traffic. Readiness requires
  PostgreSQL reachable, a compatible migration ledger with valid checksum identities, no
  evidence-persistence fail-closed latch, valid required startup configuration, and usable required
  local effect roots. Failure responses are bounded, deterministic 503s with `ready: false` and a
  sanitized `reason` plus `readiness` facts; they never expose credentials, raw database errors, or
  filesystem paths.
- `capacity` — process work-admission load state (`capacity.mutationAdmission`, the same bounded
  metrics as the operational summary). Capacity saturation is observable but NEVER marks an
  otherwise-ready process unready: readiness-driven HTTP 503 is produced only by readiness
  failures, never by backpressure.

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
