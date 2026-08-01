-- Tranche 4 — role-scoped economic accounting.
--
-- Two tables, and deliberately not a monetary dimension on run_budget_charges:
-- that table is keyed run_id NOT NULL with a closed dimension CHECK, so it
-- cannot represent planning (which spends before any Run exists), cannot carry
-- money without altering a database-level constraint, and cannot express a
-- shared Ticket-level pool because its limits come from each run's own snapshot.
--
-- The invariant this schema exists to enforce is a cross-row sum under
-- concurrency: SUM(reserved + settled) <= authorized, written by transactions
-- that hold different run_ids and, for planning, no run at all. That needs a
-- lockable account row plus a ledger with database-level CHECKs; JSONB on the
-- ticket cannot express it, and revision-guarding the ticket would serialize
-- every unrelated ticket write behind budget reservation.

CREATE TABLE ticket_economic_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  -- Closed to the two canonical execution roles. Ordinary historical execution
  -- has no role and therefore no account.
  role TEXT NOT NULL CHECK (role IN ('structured_planner', 'structured_leaf_executor')),
  economic_policy_id TEXT NOT NULL CHECK (length(btrim(economic_policy_id)) BETWEEN 1 AND 128),
  economic_policy_hash TEXT NOT NULL CHECK (economic_policy_hash ~ '^[0-9a-f]{64}$'),
  authorized_micro_usd BIGINT NOT NULL CHECK (authorized_micro_usd >= 0),
  reserved_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  settled_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (settled_micro_usd >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The whole point: no oversubscription, enforced by the database rather than
  -- by application discipline.
  CONSTRAINT ticket_economic_accounts_within_authority CHECK (
    reserved_micro_usd + settled_micro_usd <= authorized_micro_usd
  ),
  -- Exactly one account per Ticket per role, so the planner pool and the worker
  -- pool are isolated and sibling workers contend against one shared account.
  CONSTRAINT ticket_economic_accounts_ticket_role_unique UNIQUE (ticket_id, role),
  -- Reservations reference the account by (id, ticket_id, role) so a reservation
  -- can never be attached to an account belonging to another ticket or role.
  CONSTRAINT ticket_economic_accounts_identity_unique UNIQUE (id, ticket_id, role)
);

CREATE INDEX ticket_economic_accounts_ticket_idx
  ON ticket_economic_accounts (ticket_id, role);

CREATE TRIGGER ticket_economic_accounts_revision_guard
BEFORE UPDATE ON ticket_economic_accounts
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();

-- One row per provider request. The subject is exactly one of a planning
-- attempt or a Run model request, never both and never neither.
--
-- SCOPE OF WHAT THIS SCHEMA PROVES. The lifecycle CHECK proves one direction
-- only:
--
--   state = 'released'  =>  the request was never started
--
-- It does NOT prove that orchestration will never dispatch a started request
-- twice. No table constraint can: dispatch happens outside the database. That
-- guarantee comes from the store's one-winner `reserved -> request_started`
-- transition, which grants dispatch authority to exactly one caller and denies
-- it to every later one. The schema makes the correct transaction
-- representable; the store transaction is what makes it binding.
--
-- Planning attempts live in the ticket JSONB body rather than a table, so
-- planning_attempt_id carries a UUID format CHECK instead of a foreign key. A
-- Run subject uses the repository's composite (run_id, ticket_id) reference, so
-- a reservation cannot name a Run belonging to a different ticket.
CREATE TABLE economic_request_reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('structured_planner', 'structured_leaf_executor')),
  planning_attempt_id UUID,
  run_id BIGINT,
  -- Which request of the subject this is. Planning admits exactly one; a worker
  -- Run issues an ordered sequence.
  model_request_ordinal INTEGER NOT NULL CHECK (model_request_ordinal >= 1),

  -- Immutable authority this reservation was admitted under. Every one of these
  -- is required: a reservation that cannot name its exact request, route,
  -- authority and target is not accountable.
  exact_request_hash TEXT NOT NULL CHECK (exact_request_hash ~ '^[0-9a-f]{64}$'),
  routing_decision_hash TEXT NOT NULL CHECK (routing_decision_hash ~ '^[0-9a-f]{64}$'),
  economic_authority_hash TEXT NOT NULL CHECK (economic_authority_hash ~ '^[0-9a-f]{64}$'),
  target_evidence_hash TEXT NOT NULL CHECK (target_evidence_hash ~ '^[0-9a-f]{64}$'),
  adapter_capability_hash TEXT NOT NULL CHECK (adapter_capability_hash ~ '^[0-9a-f]{64}$'),
  -- Null only for an explicitly zero-priced route, which needs no model
  -- capability because its maximum is exactly zero.
  model_capability_hash TEXT CHECK (
    model_capability_hash IS NULL OR model_capability_hash ~ '^[0-9a-f]{64}$'
  ),
  pricing_catalog_hash TEXT NOT NULL CHECK (pricing_catalog_hash ~ '^[0-9a-f]{64}$'),
  pricing_entry_hash TEXT NOT NULL CHECK (pricing_entry_hash ~ '^[0-9a-f]{64}$'),

  -- THE AUTHORIZED BYTES THEMSELVES, not merely a hash of them.
  --
  -- A hash proves equality only when some other byte sequence is supplied for
  -- comparison. It does not PRESERVE the authorized bytes across process
  -- failure, and it would let a caller hand a different prepared request to the
  -- start transition and receive dispatch authority for it. The row therefore
  -- retains the complete normalized prepared request and its exact serialized
  -- text, so the winning start transition can return the bytes that were priced
  -- and reserved rather than trusting a caller to re-supply them.
  -- THE DURABLE PRICING BASIS.
  --
  -- Hashes prove equality against a document someone still holds; they do not
  -- PRESERVE it. Settlement happens after the provider responds — possibly
  -- after a restart, possibly after an administrator has re-priced or deleted
  -- the catalog entry this request was reserved under. Re-pricing an old
  -- request from current configuration would charge it at rates it was never
  -- authorized against, and refusing because the entry moved would strand the
  -- reservation forever. Both are wrong, so the complete normalized authority
  -- and the exact pricing entry are retained here as immutable historical
  -- fact, and settlement reads only these.
  --
  -- The entry carries every rule needed to recompute actual cost: input rate,
  -- output rate, fixed request charge, charging unit, bound method and the
  -- ceilings. Rounding is a property of the contract, not of the row.
  economic_authority JSONB NOT NULL CHECK (jsonb_typeof(economic_authority) = 'object'),
  pricing_entry_snapshot JSONB NOT NULL CHECK (jsonb_typeof(pricing_entry_snapshot) = 'object'),
  prepared_request JSONB NOT NULL CHECK (jsonb_typeof(prepared_request) = 'object'),
  serialized_request TEXT NOT NULL CHECK (length(serialized_request) > 0),
  -- Tied to the text itself rather than merely required to be positive: a
  -- count that disagreed with the bytes would misreport what was authorized,
  -- and a caller writing one field from a different source than the other would
  -- otherwise go unnoticed until dispatch.
  serialized_request_byte_count BIGINT NOT NULL CHECK (
    serialized_request_byte_count = octet_length(serialized_request)
  ),
  prepared_request_hash TEXT NOT NULL CHECK (prepared_request_hash ~ '^[0-9a-f]{64}$'),

  reserved_max_micro_usd BIGINT NOT NULL CHECK (reserved_max_micro_usd >= 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (
    state IN ('reserved', 'request_started', 'response_persisted', 'settled', 'released')
  ),
  -- Immutable settlement receipt, present only once settled.
  settlement_receipt JSONB CHECK (
    settlement_receipt IS NULL OR jsonb_typeof(settlement_receipt) = 'object'
  ),
  settled_micro_usd BIGINT CHECK (settled_micro_usd IS NULL OR settled_micro_usd >= 0),
  response_identity TEXT CHECK (
    response_identity IS NULL OR length(btrim(response_identity)) BETWEEN 1 AND 512
  ),
  -- Required alongside the identity: settlement binds the response hash, and
  -- recovery must reconstruct that binding without caller memory.
  response_hash TEXT CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  response_persisted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),

  -- The reservation belongs to an account for THIS ticket and THIS role, so a
  -- planner reservation can never consume a worker account or vice versa.
  CONSTRAINT economic_request_reservations_account_fk
    FOREIGN KEY (account_id, ticket_id, role)
    REFERENCES ticket_economic_accounts (id, ticket_id, role) ON DELETE RESTRICT,
  -- A Run subject must belong to the same ticket as the reservation.
  CONSTRAINT economic_request_reservations_run_fk
    FOREIGN KEY (run_id, ticket_id) REFERENCES runs (id, ticket_id) ON DELETE RESTRICT,

  -- Exactly one subject.
  CONSTRAINT economic_request_reservations_one_subject CHECK (
    (planning_attempt_id IS NOT NULL AND run_id IS NULL) OR
    (planning_attempt_id IS NULL AND run_id IS NOT NULL)
  ),
  -- The subject form must match the role.
  CONSTRAINT economic_request_reservations_subject_matches_role CHECK (
    (role = 'structured_planner' AND planning_attempt_id IS NOT NULL) OR
    (role = 'structured_leaf_executor' AND run_id IS NOT NULL)
  ),

  -- Lifecycle fields cannot contradict lifecycle state.
  CONSTRAINT economic_request_reservations_lifecycle_shape CHECK (
    (state = 'reserved'
       AND started_at IS NULL AND response_persisted_at IS NULL
       AND settled_at IS NULL AND released_at IS NULL
       AND settlement_receipt IS NULL AND settled_micro_usd IS NULL
       AND response_identity IS NULL AND response_hash IS NULL) OR
    (state = 'request_started'
       AND started_at IS NOT NULL AND response_persisted_at IS NULL
       AND settled_at IS NULL AND released_at IS NULL
       AND settlement_receipt IS NULL AND settled_micro_usd IS NULL
       AND response_identity IS NULL AND response_hash IS NULL) OR
    (state = 'response_persisted'
       AND started_at IS NOT NULL AND response_persisted_at IS NOT NULL
       AND response_identity IS NOT NULL AND response_hash IS NOT NULL
       AND settled_at IS NULL AND released_at IS NULL
       AND settlement_receipt IS NULL AND settled_micro_usd IS NULL) OR
    (state = 'settled'
       AND started_at IS NOT NULL AND settled_at IS NOT NULL
       AND settlement_receipt IS NOT NULL AND settled_micro_usd IS NOT NULL
       AND released_at IS NULL) OR
    -- Release is permitted ONLY before the request was started. A started
    -- request may have reached the provider, so it can never be released; it
    -- settles, conservatively if necessary.
    (state = 'released'
       AND started_at IS NULL AND response_persisted_at IS NULL
       AND settled_at IS NULL AND released_at IS NOT NULL
       AND settlement_receipt IS NULL AND settled_micro_usd IS NULL
       AND response_identity IS NULL AND response_hash IS NULL)
  ),
  -- A response identity and its hash are inseparable.
  CONSTRAINT economic_request_reservations_response_pair CHECK (
    (response_identity IS NULL AND response_hash IS NULL) OR
    (response_identity IS NOT NULL AND response_hash IS NOT NULL)
  ),
  -- Settlement can never exceed what was reserved.
  CONSTRAINT economic_request_reservations_settled_within_reserved CHECK (
    settled_micro_usd IS NULL OR settled_micro_usd <= reserved_max_micro_usd
  ),
  -- Settled and released are mutually exclusive terminal outcomes.
  CONSTRAINT economic_request_reservations_terminal_exclusive CHECK (
    NOT (settled_at IS NOT NULL AND released_at IS NOT NULL)
  ),
  CONSTRAINT economic_request_reservations_timestamp_order CHECK (
    (started_at IS NULL OR started_at >= created_at) AND
    (response_persisted_at IS NULL OR response_persisted_at >= started_at) AND
    (settled_at IS NULL OR settled_at >= started_at)
  ),

  -- One reservation per canonical request source. This is what makes a repeated
  -- reservation attempt idempotent-or-refused rather than a second charge, and
  -- what stops a reservation being reused across tickets, roles, subjects or
  -- request ordinals.
  CONSTRAINT economic_request_reservations_planner_source_unique
    UNIQUE (ticket_id, role, planning_attempt_id, model_request_ordinal),
  CONSTRAINT economic_request_reservations_worker_source_unique
    UNIQUE (ticket_id, role, run_id, model_request_ordinal)
  -- NOTE: exact_request_hash is deliberately NOT unique, at any scope. Two
  -- independent authorized requests may legitimately serialize to identical
  -- bytes — two sibling leaf Runs with identical declared work do exactly that,
  -- and so can a planner request and a worker request on the same Ticket.
  -- Uniqueness belongs to the canonical request SOURCE (the two constraints
  -- above); the request hash is a required immutable binding fact, not an
  -- identity. Making it unique would refuse a legitimate second reservation.
);

CREATE INDEX economic_request_reservations_account_idx
  ON economic_request_reservations (account_id, state, id);

CREATE INDEX economic_request_reservations_recovery_idx
  ON economic_request_reservations (state, started_at)
  WHERE state IN ('request_started', 'response_persisted');

CREATE TRIGGER economic_request_reservations_revision_guard
BEFORE UPDATE ON economic_request_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_entity_revision();
