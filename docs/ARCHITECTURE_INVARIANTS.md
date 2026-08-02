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

A Run carrying `leafRunBinding` must carry complete `governedExecution`, and
governed authority may not appear without a binding. One canonical rule enforces
this at creation and at reconstruction, so every read path inherits it. Record
age never excuses a malformed combination.

A structured planning attempt is request-capable only from `request_started`
onward, and a request-capable attempt without complete governed state is an
integrity failure.

Projections read durable rows. A balance is never derived by summing
reservations, and the durable lifecycle vocabulary is never collapsed into a
single boolean.

## Verified progress and churn control

Activity, candidate progress, verified progress and completion are four distinct
levels and are never collapsed into one. Only newly satisfying a previously
unsatisfied declared-work fact is verified progress, and only verified progress
extends tolerance. Completion is owned exclusively by the completion-decision and
aggregate-decision contracts; no progress signal may assert it.

Progress state is reconstructed from durable rows under an explicit cutoff
captured in a single statement, never carried in a process-local counter. A
counter that resets on recovery is a counter a model can evade by crashing.

Cumulative execution duration is measured from the immutable execution epoch —
the earliest append-only `run.lease_acquired` event — so it survives every
recovery. Admission time and the latest-attempt `started_at` are never duration
authority. Evaluation instants come from the database clock, captured in the same
statement and snapshot as the row cutoffs. Verified progress may reset a churn
streak; it never resets cumulative duration.

A churn decision has exactly two values, `continue` and `blocked`. There is no
retry, reroute, replan, or automatic remediation, and a blocked Run is never
automatically reopened. A persisted block is the decision of record: it is read,
not re-derived, and rows committed after its cutoff do not rewrite it.

A governed request is recorded and charged only once it is ADMITTED and this
caller has won dispatch authority, and always before any byte leaves. Recorded
earlier, a request the progress control refused still consumed a runtime-budget
charge and left a replay item claiming it was issued, so the budget ledger
counted requests the economic ledger and the transport did not. Recorded later,
a crash mid-flight would leave no trace of a request that may already have
reached the provider.

Postcondition evidence is canonical, append-only and complete per window. One
baseline verdict per admitted fact is captured before the first governed
request, and every receipt-bearing batch owes one verdict per admitted fact.
MISSING OR PARTIAL EVIDENCE IS AN INTEGRITY FAILURE, NEVER AN UNSATISFIED FACT:
"we did not record it" and "it did not advance" are different statements, and
only one of them may stop a Run for churn.

Only these criterion classes are execution-evaluable: `folder_exists`,
`path_absent`, `file_content_equals`. An unsupported class is reported
unsupported, never unsatisfied. A governed leaf Run admitting no
execution-evaluable fact is refused at admission rather than allowed to run and
stop later with a reason that would be false about its work.

Completion additionally requires an objective the deterministic grammar
recognizes. The completion decision evaluates recorded verification claims, and
those exist only for a compiled contract, so a Run with an unrecognized
objective can execute and write correct evidence and still never be completable.

A no-progress block is persisted BEFORE any further spending. Withholding is
proved in production in both directions: new verified progress authorizes the
next governed request, and its absence durably withholds one — no second budget
charge, no second economic reservation, no second provider-request replay item,
and no second transport call.

Structured siblings have no dependency graph and no ordering. A read of another
item's owned output is refused and the reading Run stops; it never waits. A
completed sibling becomes readable only through a reconciled item disposition of
`completed` carrying a valid completion decision hash — terminal Run status is
not completion.
