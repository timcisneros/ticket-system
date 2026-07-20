# Primitive Glossary

- **Ticket** — durable work assignment, objective, policy, provenance, and ticket status.
- **Run** — one lease-fenced execution attempt for a ticket. Retries create new runs.
- **Agent** — configured worker identity with a model provider and model.
- **Authority** — permissions and run-scoped delegation governing allowed operations.
- **Target Provider** — boundary through which external reads and mutations occur.
- **Workspace** — filesystem target rooted at `WORKSPACE_ROOT`; it is not structured runtime
  persistence.
- **Event** — append-only PostgreSQL evidence of a structured occurrence. Run events are sequenced
  and hash chained.
- **Replay** — durable structured execution evidence for a run; it is not executable rollback.
- **Operation Receipt** — immutable completion evidence for an admitted target operation.
- **Prepared Intent** — durable pre-effect record used to reconcile an interrupted external effect.
- **Log** — diagnostic/operator narrative. It supplements but does not replace structured evidence.
- **Evaluation** — immutable terminal assessment of run outcome.
- **Consequence** — immutable terminal policy result derived after evaluation.
- **Lease** — time-bounded PostgreSQL ownership required for a worker to progress a run.
- **Run Admission** — deployment-wide PostgreSQL decision enforcing run/provider concurrency before
  a claim.
- **Mutation Admission** — recoverable, process-local bound on outstanding mutation-producing work;
  it is not a global execution limit.
- **Triage** — human review state for blocked, failed, or ambiguous work.
- **Timeline / Decision Map** — read-only projections of recorded evidence; neither owns state.
- **Process Template** — versioned reusable ticket definition, optionally scheduled.
- **Work Context** — grouping/scope metadata; it never grants execution authority by itself.
- **Workflow** — persisted ordered action definition with deterministic branch links.
- **Watcher** — bounded observer/proposer. A proposal does not execute until approved into a ticket.
- **Model Provider** — service that produces agent reasoning/actions, distinct from the target
  provider.
- **Model Routing Policy** — dispatch rule whose selected provider/model is snapshotted on the run.
- **Connector** — Work-Context-scoped source/target adapter. The current `local_mock` connector is a
  contract fixture, not a production integration.
- **Operational Summary** — read-only bounded projection at `/ops`; it creates no source of truth.
- **Release Checkpoint** — current deterministic gate invoked with
  `TEST_DATABASE_URL=... npm run checkpoint:release`.
