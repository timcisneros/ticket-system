-- Tranche 5 — canonical durable evidence that an admitted declared-work fact
-- became satisfied.
--
-- THE DEFECT THIS CLOSES.
--
-- Governed progress evaluation can credit verified progress only when something
-- durable proves a previously unsatisfied admitted fact is now satisfied.
-- Nothing durable did. The runtime's only carrier for postcondition results was
-- `replay_snapshots`: ONE MUTABLE ROW PER RUN (`run_id PRIMARY KEY`, a
-- `revision` counter), whose items are stamped with the PROCESS clock and carry
-- no per-item identity. Production therefore passed no satisfied-fact mapping at
-- all, `verifiedProgressCount` was structurally zero, and a Run that genuinely
-- advanced its declared work was still stopped and labelled
-- `verified_progress_exhausted` — a persisted reason that was false.
--
-- WHY THE REPLAY SNAPSHOT CANNOT BE THE AUTHORITY.
--
--   * no cutoff is expressible — there is no monotonic id, so a claim appended
--     moments ago is indistinguishable from one that preceded the evaluation;
--   * ordering authority would revert to the process clock, which the execution
--     epoch work deliberately removed;
--   * the row is rewritten in place, so "later facts do not rewrite an existing
--     evaluation" cannot hold the way it does for the hash-chained event log.
--
-- Feeding it into progress evaluation would have broken the stable-cutoff proof,
-- the database-time proof, and the A3 closure that rests on both. The replay
-- snapshot remains presentation and replay state; it is not authority here.
--
-- WHY NOT THE EVENT LOG. The append-only `events` table supplies a monotonic
-- `position`, a database `ts`, immutability, Run/Ticket binding and cheap
-- `position <= cutoff` filtering — but it has no operation-receipt binding, no
-- closed per-type payload schema at the database, and no idempotent insertion
-- for this shape (`seq` orders the chain; it does not dedupe by run + receipt +
-- fact). Carrying the causal binding inside a generic JSONB payload would make
-- exactly the integrity and cutoff queries this table exists to answer
-- ambiguous, with no foreign key and no uniqueness behind them.
--
-- SO: one minimal relational table. Not a general evidence framework, and not a
-- second progress ledger — it records only that a NAMED admitted fact was
-- deterministically evaluated against a NAMED durable receipt, and what the
-- canonical evaluator said.

CREATE TABLE governed_postcondition_evidence (
  -- Database-assigned monotonic identity. This is what makes a stable evidence
  -- cutoff expressible at all: every evaluation filters `id <= cutoff`.
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  ticket_id BIGINT NOT NULL,
  run_id BIGINT NOT NULL,
  allocation_plan_id BIGINT NOT NULL CHECK (allocation_plan_id > 0),
  allocation_item_id BIGINT NOT NULL CHECK (allocation_item_id > 0),

  -- The authority this evidence was produced under, captured at admission. A
  -- row whose authority no longer matches the Run is foreign evidence and is
  -- refused on read rather than credited.
  governed_authority_hash TEXT NOT NULL
    CHECK (governed_authority_hash ~ '^[0-9a-f]{64}$'),
  completion_authority_hash TEXT NOT NULL
    CHECK (completion_authority_hash ~ '^[0-9a-f]{64}$'),

  -- The admitted declared-work fact this evidence is about. For a typed
  -- postcondition the declared-fact identity IS the criterion hash — the
  -- verified-progress contract already uses `criterion.criterionHash` as the
  -- fact identity — so the two columns agree by construction and are both
  -- stored, because agreeing is a property worth being able to check.
  declared_fact_identity TEXT NOT NULL
    CHECK (declared_fact_identity ~ '^[0-9a-f]{64}$'),
  criterion_hash TEXT NOT NULL CHECK (criterion_hash ~ '^[0-9a-f]{64}$'),
  criterion_type TEXT NOT NULL CHECK (length(btrim(criterion_type)) > 0),

  -- Which evaluator produced the verdict, and at what version. A verdict from
  -- an unsupported evaluator version fails closed rather than being trusted.
  evaluator_identity TEXT NOT NULL CHECK (length(btrim(evaluator_identity)) > 0),
  evaluator_version INTEGER NOT NULL CHECK (evaluator_version > 0),

  -- THE CAUSAL BINDING. Evidence exists only about a durable receipt that
  -- already committed; the foreign key makes that inarguable rather than
  -- conventional.
  operation_receipt_id BIGINT NOT NULL,

  -- The governed request opportunity this evaluation belongs to, where one
  -- applies. Same canonical identity the budget ledger and economic
  -- reservations use, so the three cannot name one request differently.
  logical_source_identity TEXT
    CHECK (logical_source_identity IS NULL OR length(logical_source_identity) <= 512),

  -- The normalized evidence the evaluator actually read. Bounded and closed by
  -- the contract; never model prose, never a request body.
  observed_evidence JSONB NOT NULL CHECK (jsonb_typeof(observed_evidence) = 'object'),

  -- The deterministic verdict. Two values only: a fact is satisfied or it is
  -- not. "Unknown" is not recorded as evidence — absence of a row is absence of
  -- evidence, which is a different and truthful statement.
  satisfied BOOLEAN NOT NULL,

  -- DATABASE time, defaulted here so no caller can supply a process clock.
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  -- Covers every field above. A row that does not hash to its own contents is
  -- refused on read.
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT governed_postcondition_evidence_run_ticket_fk
    FOREIGN KEY (run_id, ticket_id) REFERENCES runs(id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT governed_postcondition_evidence_receipt_fk
    FOREIGN KEY (operation_receipt_id) REFERENCES operation_receipts(id) ON DELETE RESTRICT,

  -- IDEMPOTENCY. Re-evaluating the same fact against the same receipt is the
  -- normal consequence of recovery and must not append a second row. A genuine
  -- conflict — the same pair with a different verdict — is refused by the store
  -- comparing `evidence_hash`, not silently kept as a second opinion.
  CONSTRAINT governed_postcondition_evidence_idempotent
    UNIQUE (run_id, operation_receipt_id, declared_fact_identity)
);

-- The read every evaluation performs: this Run's evidence at or below a cutoff,
-- in identity order.
CREATE INDEX governed_postcondition_evidence_run_cutoff_idx
  ON governed_postcondition_evidence (run_id, id);

COMMENT ON TABLE governed_postcondition_evidence IS
  'Canonical durable proof that an admitted declared-work fact was '
  'deterministically evaluated against one committed operation receipt. '
  'Append-only, database-ordered, cutoff-bounded; the only authority governed '
  'progress evaluation may credit as verified progress.';

COMMENT ON COLUMN governed_postcondition_evidence.operation_receipt_id IS
  'The committed receipt this evaluation is about. Evidence never precedes the '
  'receipt it cites.';

COMMENT ON COLUMN governed_postcondition_evidence.satisfied IS
  'Deterministic verdict from the canonical evaluator. Never a model claim, an '
  'operation success, or a caller-supplied boolean.';
