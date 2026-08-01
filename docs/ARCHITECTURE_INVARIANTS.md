# Architecture Invariants

Purpose: Protect substrate semantics from local overfitting regressions.

## 1. Generic Substrate Semantics

Ticket-specific behavior must not become runtime semantics. The runtime executes generic operations. A particular ticket's expected sequence (e.g., "create A/B then move folders") belongs in the model prompt or workload profile, not in hardcoded runtime branching.

## 2. Preserve Abstractions

Fix failing behavior without collapsing reusable abstractions. If a model fails a task, strengthen guidance or adjust the prompt. Do not replace a generic phase system with a task-specific script or special-case handler in the execution loop.

## 3. Bounded Execution

Do not raise limits to compensate for poor workload design. `maxExecutionSteps`, `maxListDirectoryPerRun`, `maxMutatingActionsPerResponse`, and other limits define the operational envelope. If a task exceeds the envelope, redesign the task or the model plan. Do not widen the envelope to make a benchmark pass.

## 4. Preserve Enforcement

Do not weaken no-progress or phase enforcement because a model failed. If a model repeats inspection without mutation, the runtime must still flag non-progress. Enforcement mechanisms are not failures to be fixed by removing them.

## 5. Generic Phase Semantics

`DISCOVER → MUTATE → VERIFY → COMPLETE` remains the generic operational structure. Phases are not ticket-specific. A/B organization and archive tasks both use the same four phases. Do not insert ticket-specific phases (e.g., "SORT", "GROUP") into the runtime.

## 6. Embedded Planning

Planning may exist inside mutation reasoning. The model can plan which mutations to emit while emitting them. Do not require planning-only non-mutating responses between DISCOVER and MUTATE. The MUTATE phase may include implicit planning in its message or reasoning.

## 7. Runtime Authority

Runtime governs execution semantics. The model proposes bounded operations; the runtime executes, verifies, and enforces limits. The runtime does not delegate structural verification back to the model. The model does not override runtime authority.

## 8. Workload Profiles Are Examples, Not Substrate Rules

Profiles may specialize guidance (e.g., tighter listDirectory limits for bulk-inventory, explicit batch instructions for refactor). Runtime semantics remain generic. A profile change must not introduce new runtime concepts or bypass existing enforcement.

## 9. Evidence Preservation

Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers. Enforcement warnings may be added to the feedback loop, but they must not overwrite the evidence that downstream logic (transition guidance, postcondition checks, replay reconstruction) depends on.

## 10. Governed Execution (Tranche 4)

No governed provider request may occur before a durable reservation exists and a
one-winner start transition has been won. This is structural, not conventional:
the transport is handed the start result and there is no other way to reach it.

`reserved + settled <= authorized` is enforced by the database, so an account
cannot be oversubscribed even if application logic is wrong.

Exactly one reservation exists per (Run, logical request source). Duplicate
orchestration of one logical request is re-reported idempotently; it never
receives the next ordinal.

Release is legal only before start. A started request settles — conservatively
if its outcome is unknown — and is never handed back.

Settlement never reads current pricing, policy or catalog configuration.

A structured leaf Run with complete governed authority cannot reach an
ungoverned provider adapter. A Run with partial authority reaches neither path.

Projections read durable rows. A balance is never derived by summing
reservations, and the durable lifecycle vocabulary is never collapsed into a
single boolean.
