# T2 Implementation Tranche 1

Tranche 1 establishes the foundational pure contracts and lock-protocol
correction that every later T2 tranche depends on. It does NOT yet
implement the full five-state migration; later tranches own
`cancellation_authority` schema migration, blocker supersession events,
historical closed-row migration, API/UI compatibility, and final T2
closure.

## What Tranche 1 Owns

1. **Canonical pure lifecycle projection**
   - `runtime/ticket-lifecycle-contract.js` exports the frozen five-state
     semantics as a pure topology-neutral projector that consumes only
     durable established authority.
   - Precedence (highest wins):
     1. cancellation authority present → `canceled`
     2. current authoritative unsettled attempt → `in_progress`
     3. most-recent authoritative settled attempt has verified
        `completed` → `completed`
     4. established unresolved durable blocking authority → `blocked`
     5. otherwise → `open`
   - Failed and interrupted attempt dispositions do NOT elevate into
     canonical Ticket lifecycle. They project to `open` when no blocker
     is present, and to `blocked` when a blocker is.
   - The projector does NOT inspect execution topology. It does not
     know planner, leaf, delegation, process, or workflow topology.

2. **Shared attempt completion authority extraction**
   - `runtime/ticket-attempt-completion-contract.js` exports
     `evaluateAttemptCompletionAuthority` and
     `validateRoutedMemberProjection`.
   - These are the SHARED RULE between settlement and (future)
     cancellation. They reuse the existing canonical
     `evaluateRunCompletionEvidence` and
     `deriveTicketAttemptDisposition` from
     `runtime/ticket-attempt-contract.js` and
     `runtime/structured-allocation-leaf-run-contract.js`.
   - The inline owner in `transitionTicketAfterRun` has been replaced
     with calls to the extracted functions. Inline behavior is preserved
     verbatim.

3. **v2 pure authority evaluation extraction**
    - `runtime/v2-completion-authority-contract.js` exports
      `evaluateV2CompletionAuthority` — the SHARED RULE answering the
      canonical question: given the currently durable authoritative evidence
      under lock, is completion already deterministically established?
    - Source-derived classification of the persisted `aggregateDecision`
      (proven, not assumed): it is a MATERIALIZED PROJECTION written solely
      by `_reconcileLeafItemsLocked`; it may legitimately go stale
      (pending/running/interrupted) while evidence advances, because
      `run_consequences` rows are insertable at any time after the run is
      terminal and run statuses advance to terminal. `normalizeAggregatePlanDecision`
      proves structure/integrity/binding — it does NOT prove freshness — and a
      malformed or misbound stored aggregate is an INTEGRITY FAILURE that
      throws, exactly as the production row read (`allocationPlanFromRow`)
      aborts the reading transaction; it is never silently reinterpreted as
      "not authority, fresh decides".
    - TERMINAL aggregates (completed/failed) are final by construction of
      their immutable inputs plus MECHANICAL LEAF-LINEAGE CLOSURE. Binding
      immutability on an existing Run ("bindings freeze at INSERT") proves
      only that an existing binding cannot change; closure — that no NEW Run
      can later be admitted carrying a binding to an already-admitted
      plan/item — is enforced at the admission boundary itself:
      `createRun`, the single Run INSERT funnel (every path — direct calls,
      `createRunsAndStartTicket`, `createRetryRun`, structured leaf
      admission — composes over it), refuses record-carried `leafRunBinding`
      unless the caller holds the leaf-lineage MINTING CAPABILITY — a
      module-private, unexported Symbol defined inside
      `persistence/postgres/store.js` (`LEAF_LINEAGE_MINT`). The capability
      is NOT an option value a caller can choose: a transaction client,
      reserved identities, a governed envelope or a valid self-hashed
      binding are facts, not authorization, and a forged authority value
      (boolean `true`, string, object, or a caller-created Symbol with the
      same description) is refused outright
      (`RUN_LEAF_LINEAGE_AUTHORITY_INVALID`), as is a binding with no
      capability at all (`RUN_LEAF_LINEAGE_NOT_CALLER_OWNED`). Only the
      canonical `admitStructuredAllocationLeafRuns` — in the same module,
      locking the admitted plan, reserving exact Run identities, re-deriving
      every binding and re-verifying the persisted rows — can pass it;
      `transitionRun` refuses leafRunBinding patches
      (`RUN_LEAF_LINEAGE_IMMUTABLE`); and the canonical admission refuses
      any second admission on its own layers (`plan_not_pending` once the
      plan has settled; foreign/incomplete leaf-set refusals while pending).
      Terminal run statuses have empty transition sets and decisions are
      write-once per run. A structurally valid terminal aggregate
      conflicting with current evidence is therefore an integrity
      contradiction, unreachable through legitimate channels, and the
      evaluator REFUSES it (completionInevitable=false,
      persistedState='terminal_conflict') rather than choosing either side.
      The closure was proven by falsification:
      `scripts/t2-lineage-closure-postgres-test.js` rebuilds a fully valid
      binding + governed envelope for a NEW Run identity from durable
      public data (the next Run identity predicted by reading the runs
      sequence) and attempts the smuggle through every admission seam AND
      through explicit forgery of the admission authority itself. Two
      pre-correction failures are retained as evidence: (1) `store.createRun`
      ACCEPTED the smuggled bound Run, and production reconciliation then
      REFRESHED the terminal `completed` aggregate to `pending` while the
      shared evaluator refused — the exact settlement/cancellation
      divergence the terminal rule exists to prevent; (2) the round-3
      boolean gate was itself forged — a repository caller passing
      `leafLineageAdmission: true` through a public `withTransaction`
      client was ACCEPTED — which is why the authority is now the
      unforgeable private capability rather than a caller-choosable option.
      Every seam and every forged-authority variant now refuses before
      INSERT.
    - Verdict rule: completionInevitable is determined by the CURRENT
      derivation, so a stale NONTERMINAL materialization never blocks
      completion — if settlement would deterministically refresh it to
      completed with no new semantic fact, completion is already inevitable
      and a future read-only cancellation consumer must refuse. Result shape:
      `{ completionInevitable, reason, currentAggregate, persistedAggregate,
      persistedState: absent|current|stale|terminal_conflict,
      materializationRequired, planId, ticketId }`.
    - The evaluator consumes the PRODUCTION run shape (runFromRow rows with
      body fields flattened to the top level), the same rows
      `_reconcileLeafItemsLocked` consumes.
    - The persistence side effect remains in
      `_reconcileLeafItemsLocked`; the extracted evaluator is read-only.
    - The evaluator preserves the existing derivation logic verbatim by
      reusing `deriveLeafItemDisposition`, `buildAggregatePlanDecision`,
      and `normalizeAggregatePlanDecision`.

4. **Repository lock-order correction**
    - T2 Ticket-level lock order (CORRECTED after falsification; see the
      failure history below):
      `allocation_plans -> run members ORDER BY id FOR UPDATE -> ticket
      attempt FOR UPDATE -> Ticket FOR UPDATE (always last)`.
    - The Ticket FOR UPDATE is taken LAST because the schema's own evidence
      path mandates the reverse weak edge: every run-evidence writer
      (claim, start, terminalization, evidence append) locks its run row
      FOR UPDATE and then inserts an event whose foreign key
      (`events.ticket_id REFERENCES tickets(id)`) takes `tickets FOR KEY
      SHARE`. FOR KEY SHARE conflicts with FOR UPDATE, so holding the Ticket
      FOR UPDATE while waiting for any run/attempt lock forms a genuine
      40P01 cycle with a concurrent run-evidence writer. `_appendEvent`
      documents the identical boundary for run rows versus chain tips.
    - `transitionTicketAfterRun` order: routing read (no lock) -> v2
      allocation-plan lock FIRST (matching `admitStructuredAllocationLeafRuns`
      and `reconcileStructuredAllocationLeafItems`) -> all members of the
      routed attempt ORDER BY id FOR UPDATE (the routed Run is included in
      this lock; its terminal-status check happens on the locked rows) ->
      current attempt FOR UPDATE with stale-routing revalidation -> Ticket
      FOR UPDATE LAST -> decisions -> validate routed member -> compute
      aggregate -> v2 reconciliation -> persist attempt disposition ->
      transition Ticket.
    - `reopenTicket`: attempt FOR UPDATE -> Ticket FOR UPDATE (reverted from
      the falsified Ticket-first order).
    - `createRunsAndStartTicket` (with predecessor): predecessor Run FOR
      UPDATE -> current attempt FOR UPDATE -> Ticket FOR UPDATE gate. (The
      falsified Tranche 1 order was Ticket -> attempt -> predecessor Run.)
    - `createRetryRun` acquires the predecessor Run lock BEFORE composing
      `reopenTicket` + admission in one transaction, so the composed
      transaction never holds the Ticket FOR UPDATE while waiting for a run
      lock.
    - The single edge `routed Run -> members` (where the routed Run was
      locked individually before all members) is still eliminated: the
      routed Run is locked only as part of the all-members id-ordered lock.

   FAILURE HISTORY — FOUND BY FALSIFICATION -> DIAGNOSED -> FIXED ->
   ORIGINAL CONCURRENT CASE NOW PASSES. The first Tranche 1 handoff froze
   `Ticket FOR UPDATE -> attempt FOR UPDATE -> Runs` and reordered
   settlement/reopen/predecessor-admission onto it. Its own concurrency
   falsification (two members of one attempt settled concurrently through
   different member ids) produced a real PostgreSQL 40P01: the settlement
   held `tickets` FOR UPDATE while waiting for the second member-run tuple,
   while the other member's terminalization transaction held that run FOR
   UPDATE and waited for `tickets` FOR KEY SHARE (events FK) — a genuine
   cycle. The failing test was then weakened to sequential settlement. The
   corrected protocol (Ticket lock last) was verified by restoring the
   original concurrent case: it now passes repeatedly, together with the
   full concurrency matrix below. The failure is recorded in
   `docs/ARCHITECTURAL_DECISIONS_PENDING.md` (T2 Lock-Protocol Falsification
   Deadlock) and must not be re-weakened.

5. **Stale-routing revalidation**
    - `transitionTicketAfterRun` reads `ticket_id` and `ticket_attempt_id`
      from the routed Run without a lock (routing read). Members of the
      routed attempt are locked ORDER BY id; the current attempt is then
      locked FOR UPDATE.
    - If the current attempt is not the routed attempt, the routed Run's
      attempt is no longer current (a newer attempt was admitted
      concurrently). The settlement returns without changing state; the
      canonical Ticket projection must reflect the current attempt, not the
      older one.
    - This is the minimum revalidation convention. No background retry; the
      caller may retry if it wants a different outcome.

6. **Focused deterministic tests + concurrency falsification**
    - `scripts/t2-lifecycle-contract-test.js` — pure lifecycle
      projector; 27 assertions covering precedence, FAILED/INTERRUPTED
      demotion, topology neutrality, validation.
    - `scripts/t2-attempt-completion-contract-test.js` — shared
      completion authority; 22 assertions covering singleton, multi-Run,
      mixed terminal members, non-terminal member, verification
      passed/failed/unavailable, postcondition failure, validation.
    - `scripts/t2-v2-completion-authority-contract-test.js` — v2
      evaluator; 20 assertions covering the full persisted/fresh matrix:
      no-leaves, no-persisted + fresh completed/failed, the stale-materialization
      regression (a contract-valid persisted `running` aggregate over earlier
      evidence vs a fresh `completed` derivation yields completionInevitable
      TRUE — a stale nonterminal materialization cannot make completion not
      inevitable when current durable evidence already determines it), a
      stale `interrupted` materialization completed by a late-recorded
      decision, stale `pending` vs fresh `failed`, agreement on
      completed/failed, TERMINAL-conflict refusals in both directions (a
      valid persisted completed aggregate vs fresh failed, and a valid
      persisted failed aggregate vs fresh completed, both refused rather
      than resolved to either side), malformed and misbound persisted
      aggregates THROWN as integrity failures (mirroring the production row
      read), missing member/binding, historical v2 acceptance, input
      validation, and the settlement/cancellation semantic-equivalence proof:
      for every reachable matrix row, the cancellation verdict computed from
      the stored materialization equals the settlement verdict computed from
      the refreshed materialization that reconciliation deterministically
      writes from the same evidence.
    - `scripts/structured-allocation-leaf-run-postgres-test.js` carries the
      durable end-to-end stale-materialization regression: the aggregate is
      materialized nonterminal while a leaf runs, the evidence then advances
      to fully completed with no intermediate reconciliation, the shared
      evaluator answers completionInevitable=true from the same durable
      facts, and the real `transitionTicketAfterRun` settlement refreshes
      the materialization and completes the parent.
    - `scripts/t2-lock-protocol-postgres-test.js` — deterministic
      PostgreSQL concurrency tests; 37 assertions: the RESTORED original
      concurrent falsification (two full claim->start->terminalize->settle
      pipelines concurrently), isolated concurrent settlement of a
      two-member attempt in BOTH routing directions (both members durably
      terminal first), settlement-vs-reopenTicket (both live writers,
      outcome paired with its exclusive cause), settlement-vs-predecessor
      admission, settlement-vs-structured-leaf-admission (the real
      `admitStructuredAllocationLeafRuns` path, whose TWO source-legitimate
      interleavings — duplicate-admission re-report while the plan is
      pending, `plan_not_pending` refusal once settlement has committed —
      are each paired with its exclusive cause and share invariant
      assertions), and stale-attempt routing under a concurrent
      `createRetryRun` admission. A 40P01 or a deadline in any case fails
      the suite; no retry, no status widening, no serialization of the
      racing writers.
    - `scripts/t2-lineage-closure-postgres-test.js` — the leaf-lineage
      closure falsification/regression; 43 assertions: a fully valid
      rebuilt binding + governed envelope for a NEW Run identity (predicted
      by reading the runs sequence) is attempted through the `createRun`
      INSERT funnel, through `createRunsAndStartTicket` after reopen,
      through the real `createRetryRun` composition, through a
      `transitionRun` body patch (full pair and binding-only), through
      duplicate canonical leaf admission (control), AND through explicit
      forgery of the admission authority itself: a caller-forged
      `leafLineageAdmission: true` through a public `withTransaction`
      client (both seams), and forged capability values (boolean, string,
      object, caller-created Symbol carrying the private description) —
      none may confer lineage-minting authority. Every seam must refuse
      before INSERT (RUN_LEAF_LINEAGE_NOT_CALLER_OWNED /
      RUN_LEAF_LINEAGE_AUTHORITY_INVALID / RUN_LEAF_LINEAGE_IMMUTABLE /
      plan_not_pending / the pairing guard), the terminal aggregate and
      settled Ticket must remain untouched after every refusal, and the
      refused composed admissions must roll back their reopens. Two
      pre-correction failures are retained in the integrity register: the
      original createRun smuggle acceptance, and the round-3 forged-boolean
      acceptance that motivated the private capability.

## What Tranche 1 Does NOT Own

- `cancellation_authority` schema migration (later tranche)
- `cancelTicket` API/product behavior (later tranche)
- Historical six-state → five-state database migration (later tranche)
- Removal of `failed`/`closed` database values (later tranche)
- Blocker supersession event implementation (later tranche)
- Full `rerunAttemptAdmission` cutover (later tranche)
- API/UI/CLI status migration (later tranche)
- `PATCH /status` removal (later tranche)
- Airport Status UI (later tranche)

## What Stays the Same

- Ticket-attempt authority, immutable attempt membership, one
  unsettled attempt per Ticket.
- Direct execution, Workflow execution, process execution, delegation.
- Historical/current structured v2 compatibility.
- Retry/resume distinctions and immutable historical evidence.
- The lifecycle projector may consume generic durable authority facts
  but may not know planner/leaf/delegation/process topology.

## Lifecycle Vocabulary — Still Frozen

OPEN / IN_PROGRESS / BLOCKED / COMPLETED / CANCELED. FAILED remains
Run/attempt/completion outcome authority, not a Ticket lifecycle
value. WAITING remains deferred until a durable Ticket-owned wait/wake
authority exists.

## Lock Direction — CORRECTED (supersedes the falsified Ticket-first order)

Ticket-level writers acquire locks in this order:
`allocation_plans → runs (members ORDER BY id) → ticket_attempts → tickets`,
with the Ticket FOR UPDATE always taken LAST. The directed-edge graph over
the FULL lock set — explicit row locks plus the events foreign-key
`tickets FOR KEY SHARE`, `run_event_chain_tips`, and the 039 membership-guard
attempt locks acquired transitively by the same statements — has only forward
edges; no reverse edges exist; the graph is acyclic. The earlier
`Ticket → attempt → Runs` direction was falsified by a real 40P01 and is
retained nowhere.
