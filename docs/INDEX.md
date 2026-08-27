# Documentation Index

## Living current guidance

- [`../README.md`](../README.md) — architecture, startup, and verification.
- [`SETUP_AND_FIRST_RUN.md`](SETUP_AND_FIRST_RUN.md) — environment and first run.
- [`SYSTEM_STATUS.md`](SYSTEM_STATUS.md) — implemented guarantees and remaining productization work.
- [`ARCHITECTURAL_DECISIONS_PENDING.md`](ARCHITECTURAL_DECISIONS_PENDING.md) — canonical register of
  open integrity defects, deferred work, and pending architectural decisions; also carries the
  broad ticket-kernel roadmap (T0–T10) and the current-tranche brief.
  Read before starting work that touches runtime enforcement, feasibility, recovery, objective
  interpretation, or ticket-kernel sequencing.
- [`STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md`](STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md)
  — completed structured allocation and governed model economics roadmap through Tranche 6. The
  frozen evaluation ended FINAL STOP; the explicit post-result decision demotes future first-class
  structured activation while preserving general allocation/decomposition and historical readers.
- [`GOVERNED_REQUIRED_PERSISTENCE_MATRIX.md`](GOVERNED_REQUIRED_PERSISTENCE_MATRIX.md) — every
  durable write in the governed leaf lifecycle, its classification, what happens when it does not
  commit, and which partial states PostgreSQL makes structurally impossible.
- [`TERMINAL_PROJECTION_READER_CONTRACTS.md`](TERMINAL_PROJECTION_READER_CONTRACTS.md) — which
  terminal authority each operator reader owns, and the five-row reader-parity matrix.
- [`POSTGRES_CUTOVER.md`](POSTGRES_CUTOVER.md) — current PostgreSQL authority/coordination contract.
- [`PROCESS_EXECUTION_CONTRACT.md`](PROCESS_EXECUTION_CONTRACT.md) — default-off, executor-free
  bounded process-operation authority, request, outcome, evidence, and snapshot contract.
- [`PROCESS_INPUT_MATERIALIZER.md`](PROCESS_INPUT_MATERIALIZER.md) — trusted immutable
  workspace-input materialization, registry, ownership, and mutation-boundary contract.
- [`PROCESS_LAUNCHER_FOUNDATION.md`](PROCESS_LAUNCHER_FOUNDATION.md) — pinned runtime-rootfs,
  executable-identity, and non-executable sandbox-prerequisite verification contract.
- [`PROCESS_EXECUTION_ROADMAP.md`](PROCESS_EXECUTION_ROADMAP.md) — authoritative eight-tranche
  process-execution roadmap and frozen release status.
- [`PROCESS_EXECUTION_COMPATIBILITY.md`](PROCESS_EXECUTION_COMPATIBILITY.md) — exact release,
  schema, native protocol, and historical-read compatibility matrix.
- [`PROCESS_EXECUTION_GA_RUNBOOK.md`](PROCESS_EXECUTION_GA_RUNBOOK.md) — installation,
  readiness, staged enablement, disablement, backup, rollback, and incident procedures.
- [`WORK_DEFINITION_AND_TYPED_EVIDENCE_ROADMAP.md`](WORK_DEFINITION_AND_TYPED_EVIDENCE_ROADMAP.md)
  — authoritative four-tranche roadmap for typed projection parity and later structured
  work-definition authority.
- [`STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md`](STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md)
  — authoritative roadmap for structured Allocation Plan authority, the 2A parent-work/planning-principal
  prerequisite, later 2B planner admission, leaf execution, bounded economics, coordination controls,
  and the completed FINAL STOP product evaluation. All six tranches are COMPLETE; the Tranche 4 section is the reference for
  role-aware routing, immutable execution targets, bounded economics, the request lifecycle, the
  active-versus-abandoned lease rule, the formal fallback boundary, and the provider-support table.
- [`decision-memo-work-definition-and-typed-evidence.md`](decision-memo-work-definition-and-typed-evidence.md)
  — rejection of a universal Target framework and the evidence-scoped correction.
- [`decision-memo-mixed-family-work-model.md`](decision-memo-mixed-family-work-model.md)
  — representative scenario evidence and the decision to retain Ticket and Workflow as the
  product primitives.
- [`PRIMITIVE_GLOSSARY.md`](PRIMITIVE_GLOSSARY.md) — runtime terminology.
- [`TICKET_ATTEMPT_AUTHORITY.md`](TICKET_ATTEMPT_AUTHORITY.md) — topology-neutral internal
  Ticket-attempt identity, immutable Run membership, historical backfill/refusal, settlement, and
  canonical Ticket projection authority.
- [`OPERATIONAL_TRANSPARENCY.md`](OPERATIONAL_TRANSPARENCY.md) — read-only operational surfaces.
- [`OPERATOR_INBOX.md`](OPERATOR_INBOX.md) and [`BROWSER_ENVIRONMENT.md`](BROWSER_ENVIRONMENT.md) —
  active product surfaces maintained with their implementations.

These stable documents are updated when implementation changes. A fresh release checkpoint, not a
document, is verification authority.

## Historical and design reference

Other documents in this directory include point-in-time audits, experiments, milestones, release
notes, design proposals, and JSON-runtime operating notes. Their original claims are preserved as
historical evidence and are not silently refreshed into current facts. A historical document may
still explain intent, but it does not override the living documents above or active code.

Retired JSON implementation and its directly coupled tests are under
[`../ARCHIVE/legacy-json-runtime/`](../ARCHIVE/legacy-json-runtime/). Frozen evidence corpora and
other explicitly archived investigations remain under [`../ARCHIVE/`](../ARCHIVE/).
