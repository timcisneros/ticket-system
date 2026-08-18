#!/usr/bin/env node
'use strict';

// Tranche 4 PostgreSQL schema suite for migration 033.
//
// This proves the DATABASE enforces the accounting invariants, not application
// discipline. No store methods exist yet by design: the schema must make the
// future correct transaction representable and the incorrect one impossible,
// and that is exactly what is asserted here with raw SQL.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');

const ACTOR = 'economic-accounting-schema-postgres-test';
const STAMP = `${Date.now()}-${process.pid}`;
const PLANNER = 'structured_planner';
const WORKER = 'structured_leaf_executor';
const ATTEMPT = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41';

function digest(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

async function rejects(store, sql, values, why) {
  await assert.rejects(() => store.pool.query(sql, values), () => true, why);
}

async function main() {
  await withHarness('economic accounting schema PostgreSQL', async ({ store }) => {
    const accounts = store.table('ticket_economic_accounts');
    const reservations = store.table('economic_request_reservations');

    // ── Migration applied and both tables exist ────────────────────────────
    const tables = await store.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name IN
         ('ticket_economic_accounts', 'economic_request_reservations')
       ORDER BY table_name`,
      [store.schema]
    );
    assert.deepEqual(tables.rows.map(row => row.table_name),
      ['economic_request_reservations', 'ticket_economic_accounts'],
      'migration 033 applies cleanly and creates both tables');

    // Existing migrations remain readable alongside it.
    for (const historical of ['tickets', 'runs', 'allocation_plans', 'run_budget_charges']) {
      const found = await store.pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [store.schema, historical]
      );
      assert.equal(found.rowCount, 1, `${historical} remains present`);
    }
    // run_budget_charges was NOT converted into monetary accounting.
    const budgetDimensions = await store.pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = $1::regclass AND contype = 'c'`,
      [`${store.schema}.run_budget_charges`]
    );
    assert.equal(
      budgetDimensions.rows.some(row => /micro_usd|monetary/i.test(row.def)), false,
      'run_budget_charges gains no monetary dimension'
    );

    const ticket = await store.createTicket({ status: 'open', title: `T4 ${STAMP}` });
    const otherTicket = await store.createTicket({ status: 'open', title: `T4b ${STAMP}` });

    const insertAccount = async (ticketId, role, authorized = 1_000_000, extra = {}) => {
      const result = await store.pool.query(
        `INSERT INTO ${accounts}
           (ticket_id, role, economic_policy_id, economic_policy_hash,
            authorized_micro_usd, reserved_micro_usd, settled_micro_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          ticketId, role, extra.policyId || 'economic-policy-1',
          extra.policyHash || digest('policy'), authorized,
          extra.reserved ?? 0, extra.settled ?? 0
        ]
      );
      return result.rows[0];
    };

    // ── Role vocabulary is closed ──────────────────────────────────────────
    for (const role of [PLANNER, WORKER]) {
      const created = await insertAccount(ticket.id, role);
      assert.equal(created.role, role);
      assert.equal(Number(created.reserved_micro_usd), 0);
    }
    await rejects(store,
      `INSERT INTO ${accounts} (ticket_id, role, economic_policy_id, economic_policy_hash,
        authorized_micro_usd) VALUES ($1, 'verifier', 'p', $2, 1)`,
      [ticket.id, digest('p')],
      'an invented role is refused by the database');

    // ── One account per Ticket and role; planner and worker stay distinct ──
    await rejects(store,
      `INSERT INTO ${accounts} (ticket_id, role, economic_policy_id, economic_policy_hash,
        authorized_micro_usd) VALUES ($1, $2, 'p', $3, 1)`,
      [ticket.id, PLANNER, digest('p')],
      'a second planner account for one ticket is refused');
    const both = await store.pool.query(
      `SELECT role FROM ${accounts} WHERE ticket_id = $1 ORDER BY role`, [ticket.id]);
    assert.deepEqual(both.rows.map(row => row.role), [WORKER, PLANNER].sort(),
      'planner and worker accounts coexist and remain distinct');

    // ── Monetary constraints ───────────────────────────────────────────────
    for (const [column, value, why] of [
      ['authorized_micro_usd', -1, 'negative authorized refuses'],
      ['reserved_micro_usd', -1, 'negative reserved refuses'],
      ['settled_micro_usd', -1, 'negative settled refuses']
    ]) {
      await rejects(store,
        `INSERT INTO ${accounts} (ticket_id, role, economic_policy_id, economic_policy_hash,
          authorized_micro_usd, ${column}) VALUES ($1, $2, 'p', $3, 100, $4)`,
        [otherTicket.id, PLANNER, digest('p'), value], why);
    }
    // reserved + settled may not exceed authorized — the core invariant.
    await rejects(store,
      `INSERT INTO ${accounts} (ticket_id, role, economic_policy_id, economic_policy_hash,
        authorized_micro_usd, reserved_micro_usd, settled_micro_usd)
       VALUES ($1, $2, 'p', $3, 100, 60, 41)`,
      [otherTicket.id, PLANNER, digest('p')],
      'reserved + settled above authorized refuses');
    const exact = await insertAccount(otherTicket.id, PLANNER, 100, { reserved: 60, settled: 40 });
    assert.equal(Number(exact.authorized_micro_usd), 100,
      'reserved + settled exactly equal to authorized is admissible');
    await rejects(store,
      `UPDATE ${accounts} SET reserved_micro_usd = 61, revision = revision + 1 WHERE id = $1`,
      [exact.id],
      'an update that breaches the invariant refuses');
    // The revision guard applies.
    await rejects(store,
      `UPDATE ${accounts} SET reserved_micro_usd = 59 WHERE id = $1`, [exact.id],
      'an update without advancing revision refuses');

    const plannerAccount = (await store.pool.query(
      `SELECT * FROM ${accounts} WHERE ticket_id = $1 AND role = $2`,
      [ticket.id, PLANNER])).rows[0];
    const workerAccount = (await store.pool.query(
      `SELECT * FROM ${accounts} WHERE ticket_id = $1 AND role = $2`,
      [ticket.id, WORKER])).rows[0];

    // Two sibling worker sources belong to one execution wave. Their distinct
    // Run identities are needed below to prove that identical request bytes do
    // not collapse distinct canonical economic sources; Ticket-attempt
    // authority therefore admits the exact pair atomically rather than letting
    // two independent createRun calls invent overlapping singleton attempts.
    const agent = (await store.createConfiguredAgent({
      value: { name: `Worker ${STAMP}`, provider: 'openai', model: 'gpt-4o-mini-2024-07-18', apiKey: '' },
      groupIds: [], changedBy: ACTOR
    })).agent;
    const workerAdmission = await store.createRunsAndStartTicket({
      ticketId: ticket.id,
      runDrafts: [
        { ticketId: ticket.id, agentId: agent.id, status: 'pending' },
        { ticketId: ticket.id, agentId: agent.id, status: 'pending' }
      ]
    });
    const [run, secondRun] = workerAdmission.runs;
    assert.equal(workerAdmission.attempt.memberCount, 2,
      'the two sibling worker sources are one exact multi-Run Ticket attempt');
    assert.equal(run.ticketAttemptId, workerAdmission.attempt.id);
    assert.equal(secondRun.ticketAttemptId, workerAdmission.attempt.id);
    const foreignAdmission = await store.createRunsAndStartTicket({
      ticketId: otherTicket.id,
      runDrafts: [
        { ticketId: otherTicket.id, agentId: agent.id, status: 'pending' }
      ]
    });
    const [foreignRun] = foreignAdmission.runs;

    const reservationColumns = `(account_id, ticket_id, role, planning_attempt_id, run_id,
      model_request_ordinal, exact_request_hash, routing_decision_hash,
      economic_authority_hash, target_evidence_hash, adapter_capability_hash,
      model_capability_hash, pricing_catalog_hash, pricing_entry_hash,
      economic_authority, pricing_entry_snapshot,
      prepared_request, serialized_request, serialized_request_byte_count,
      prepared_request_hash, reserved_max_micro_usd, state)`;

    const insertReservation = (overrides = {}) => {
      const row = {
        accountId: workerAccount.id,
        ticketId: ticket.id,
        role: WORKER,
        planningAttemptId: null,
        runId: run.id,
        ordinal: 1,
        requestHash: digest(`req-${overrides.seed || 'a'}`),
        routingHash: digest('route'),
        authorityHash: digest('authority'),
        targetHash: digest('target'),
        adapterHash: digest('adapter'),
        modelHash: digest('model'),
        catalogHash: digest('catalog'),
        entryHash: digest('entry'),
        reserved: 20_429,
        state: 'reserved',
        ...overrides
      };
      const serialized = row.serialized === undefined
        ? JSON.stringify({ model: 'm', seed: row.requestHash })
        : row.serialized;
      return store.pool.query(
        `INSERT INTO ${reservations} ${reservationColumns}
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING *`,
        [row.accountId, row.ticketId, row.role, row.planningAttemptId, row.runId, row.ordinal,
          row.requestHash, row.routingHash, row.authorityHash, row.targetHash, row.adapterHash,
          row.modelHash, row.catalogHash, row.entryHash,
          JSON.stringify({ capturedAuthority: row.authorityHash }),
          JSON.stringify({ inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 }),
          JSON.stringify({ serializedRequest: serialized }), serialized,
          Buffer.byteLength(serialized, 'utf8'), digest(`prepared-${row.requestHash}`),
          row.reserved, row.state]
      );
    };

    // ── Exactly one subject ────────────────────────────────────────────────
    const workerReservation = (await insertReservation({ seed: 'w1' })).rows[0];
    assert.equal(workerReservation.state, 'reserved');
    assert.equal(workerReservation.planning_attempt_id, null);

    await assert.rejects(
      () => insertReservation({ seed: 'both', planningAttemptId: ATTEMPT }),
      () => true, 'a reservation naming BOTH a planning attempt and a Run refuses');
    await assert.rejects(
      () => insertReservation({ seed: 'neither', runId: null }),
      () => true, 'a reservation naming NEITHER subject refuses');
    // The subject form must match the role.
    await assert.rejects(
      () => insertReservation({
        seed: 'mismatch', accountId: plannerAccount.id, role: PLANNER, runId: run.id
      }),
      () => true, 'a planner reservation with a Run subject refuses');

    // ── Run/Ticket mismatch and account transplantation ───────────────────
    await assert.rejects(
      () => insertReservation({ seed: 'foreignrun', runId: foreignRun.id }),
      () => true, 'a Run from another ticket refuses');
    await assert.rejects(
      () => insertReservation({ seed: 'foreignacct', accountId: exact.id }),
      () => true, 'an account belonging to another ticket refuses');
    await assert.rejects(
      () => insertReservation({ seed: 'roleswap', accountId: plannerAccount.id }),
      () => true, 'a worker reservation cannot consume the planner account');

    // ── Uniqueness per canonical request source ───────────────────────────
    await assert.rejects(
      () => insertReservation({ seed: 'dupordinal' }),
      () => true, 'a duplicate worker request ordinal refuses');
    const secondOrdinal = (await insertReservation({ seed: 'w2', ordinal: 2 })).rows[0];
    assert.equal(secondOrdinal.model_request_ordinal, 2,
      'a distinct ordinal is a distinct reservation');
    // The same exact request bytes MAY be reserved by two different canonical
    // sources: two sibling leaf Runs with identical declared work serialize
    // identically, and refusing the second would refuse legitimate work.
    // Uniqueness belongs to the source, not the hash.
    const sharedHash = digest('shared-bytes');
    const firstShared = (await insertReservation({
      seed: 'shared-a', ordinal: 3, requestHash: sharedHash
    })).rows[0];
    const secondShared = (await insertReservation({
      seed: 'shared-b', ordinal: 1, runId: secondRun.id, requestHash: sharedHash
    })).rows[0];
    assert.equal(firstShared.exact_request_hash, secondShared.exact_request_hash,
      'two distinct sources may carry identical request bytes');
    assert.notEqual(firstShared.run_id, secondShared.run_id);
    // Source-identity uniqueness is unweakened.
    await assert.rejects(
      () => insertReservation({ seed: 'dupe-source', ordinal: 3 }),
      () => true, 'the same source and ordinal still refuses');

    const plannerReservation = (await insertReservation({
      seed: 'p1', accountId: plannerAccount.id, role: PLANNER,
      planningAttemptId: ATTEMPT, runId: null
    })).rows[0];
    assert.equal(plannerReservation.run_id, null);
    await assert.rejects(
      () => insertReservation({
        seed: 'p2', accountId: plannerAccount.id, role: PLANNER,
        planningAttemptId: ATTEMPT, runId: null
      }),
      () => true, 'a duplicate planner request reservation refuses');

    // ── Required authority fields ─────────────────────────────────────────
    for (const column of [
      'exact_request_hash', 'routing_decision_hash', 'economic_authority_hash',
      'target_evidence_hash', 'adapter_capability_hash', 'pricing_catalog_hash',
      'pricing_entry_hash'
    ]) {
      await assert.rejects(
        () => insertReservation({ seed: `null-${column}`, ordinal: 90, [{
          exact_request_hash: 'requestHash',
          routing_decision_hash: 'routingHash',
          economic_authority_hash: 'authorityHash',
          target_evidence_hash: 'targetHash',
          adapter_capability_hash: 'adapterHash',
          pricing_catalog_hash: 'catalogHash',
          pricing_entry_hash: 'entryHash'
        }[column]]: null }),
        () => true, `${column} is required`);
    }
    // The authorized bytes are required: a reservation without them could not
    // return the reserved request to the winning start transition.
    await assert.rejects(
      () => insertReservation({ seed: 'nobytes', ordinal: 96, serialized: '' }),
      () => true, 'an empty serialized request refuses');
    const withBytes = (await insertReservation({ seed: 'bytes', ordinal: 97 })).rows[0];
    assert.equal(
      Number(withBytes.serialized_request_byte_count),
      Buffer.byteLength(withBytes.serialized_request, 'utf8'),
      'the stored byte count matches the stored text');
    assert.match(withBytes.prepared_request_hash, /^[0-9a-f]{64}$/);
    assert.equal(typeof withBytes.prepared_request, 'object',
      'the complete prepared request is durably retained');

    // Malformed hashes refuse.
    await assert.rejects(
      () => insertReservation({ seed: 'badhash', ordinal: 91, routingHash: 'not-a-hash' }),
      () => true, 'a malformed hash refuses');
    // model_capability_hash is nullable only — a zero-priced authority needs none.
    const zeroPriced = (await insertReservation({
      seed: 'zero', ordinal: 92, modelHash: null, reserved: 0
    })).rows[0];
    assert.equal(zeroPriced.model_capability_hash, null,
      'a zero-priced reservation may omit the model capability');
    assert.equal(Number(zeroPriced.reserved_max_micro_usd), 0);

    // ── Monetary bounds on the reservation ────────────────────────────────
    await assert.rejects(
      () => insertReservation({ seed: 'neg', ordinal: 93, reserved: -1 }),
      () => true, 'a negative reserved maximum refuses');
    // BIGINT overflow refuses at the type boundary.
    await assert.rejects(
      () => store.pool.query(
        `INSERT INTO ${reservations} ${reservationColumns}
         VALUES ($1,$2,$3,NULL,$4,94,$5,$6,$7,$8,$9,$10,$11,$12,
                 99999999999999999999999, 'reserved')`,
        [workerAccount.id, ticket.id, WORKER, run.id, digest('ovf'), digest('route'),
          digest('authority'), digest('target'), digest('adapter'), digest('model'),
          digest('catalog'), digest('entry')]),
      () => true, 'an overlarge monetary value refuses at the SQL type boundary');

    // ── Lifecycle state and timestamp coherence ───────────────────────────
    await assert.rejects(
      () => insertReservation({ seed: 'badstate', ordinal: 95, state: 'in_flight' }),
      () => true, 'an invalid lifecycle state refuses');
    // `reserved` cannot carry a start time.
    await rejects(store,
      `UPDATE ${reservations} SET started_at = clock_timestamp(), revision = revision + 1
       WHERE id = $1`, [workerReservation.id],
      'a reserved row cannot carry started_at');
    // `request_started` requires started_at.
    await rejects(store,
      `UPDATE ${reservations} SET state = 'request_started', revision = revision + 1
       WHERE id = $1`, [workerReservation.id],
      'request_started requires started_at');
    await store.pool.query(
      `UPDATE ${reservations} SET state = 'request_started', started_at = clock_timestamp(),
       revision = revision + 1 WHERE id = $1`, [workerReservation.id]);
    // Release after start is unrepresentable — a started request may have
    // reached the provider, so it settles rather than being released.
    await rejects(store,
      `UPDATE ${reservations} SET state = 'released', released_at = clock_timestamp(),
       revision = revision + 1 WHERE id = $1`, [workerReservation.id],
      'release after request start is unrepresentable');
    // response_persisted requires a response identity.
    await rejects(store,
      `UPDATE ${reservations} SET state = 'response_persisted',
       response_persisted_at = clock_timestamp(), revision = revision + 1 WHERE id = $1`,
      [workerReservation.id],
      'response_persisted requires a response identity');
    // A response identity without its hash is unrepresentable.
    await rejects(store,
      `UPDATE ${reservations} SET state = 'response_persisted',
       response_persisted_at = clock_timestamp(), response_identity = 'resp-1',
       revision = revision + 1 WHERE id = $1`, [workerReservation.id],
      'a response identity requires its hash');
    await store.pool.query(
      `UPDATE ${reservations} SET state = 'response_persisted',
       response_persisted_at = clock_timestamp(), response_identity = 'resp-1',
       response_hash = $2, revision = revision + 1 WHERE id = $1`,
      [workerReservation.id, digest('resp-1')]);
    // Settlement requires a receipt and an amount.
    await rejects(store,
      `UPDATE ${reservations} SET state = 'settled', settled_at = clock_timestamp(),
       revision = revision + 1 WHERE id = $1`, [workerReservation.id],
      'settlement requires a receipt');
    // Settled amount cannot exceed the reserved maximum.
    await rejects(store,
      `UPDATE ${reservations} SET state = 'settled', settled_at = clock_timestamp(),
       settlement_receipt = '{"usageSource":"provider_reported"}'::jsonb,
       settled_micro_usd = 20430, revision = revision + 1 WHERE id = $1`,
      [workerReservation.id],
      'settlement above the reserved maximum refuses');
    await store.pool.query(
      `UPDATE ${reservations} SET state = 'settled', settled_at = clock_timestamp(),
       settlement_receipt = '{"usageSource":"provider_reported"}'::jsonb,
       settled_micro_usd = 20429, revision = revision + 1 WHERE id = $1`,
      [workerReservation.id]);
    const settled = (await store.pool.query(
      `SELECT * FROM ${reservations} WHERE id = $1`, [workerReservation.id])).rows[0];
    assert.equal(settled.state, 'settled');
    assert.equal(Number(settled.settled_micro_usd), 20_429);
    assert.equal(settled.released_at, null, 'settled and released are mutually exclusive');
    // A reservation never started may be released.
    await store.pool.query(
      `UPDATE ${reservations} SET state = 'released', released_at = clock_timestamp(),
       revision = revision + 1 WHERE id = $1`, [secondOrdinal.id]);
    const released = (await store.pool.query(
      `SELECT * FROM ${reservations} WHERE id = $1`, [secondOrdinal.id])).rows[0];
    assert.equal(released.state, 'released');
    assert.equal(released.settlement_receipt, null, 'release is not settlement');

    // ── Rollback leaves no partial state ──────────────────────────────────
    const beforeAccounts = (await store.pool.query(`SELECT count(*)::int AS n FROM ${accounts}`))
      .rows[0].n;
    const beforeReservations =
      (await store.pool.query(`SELECT count(*)::int AS n FROM ${reservations}`)).rows[0].n;
    await assert.rejects(
      () => store.withTransaction(async client => {
        await client.query(
          `INSERT INTO ${accounts} (ticket_id, role, economic_policy_id, economic_policy_hash,
            authorized_micro_usd) VALUES ($1, $2, 'p', $3, 500)`,
          [otherTicket.id, WORKER, digest('p')]);
        const error = new Error('injected rollback');
        error.code = 'TEST_INJECTED_ROLLBACK';
        throw error;
      }),
      error => error.code === 'TEST_INJECTED_ROLLBACK'
    );
    assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM ${accounts}`)).rows[0].n,
      beforeAccounts, 'rollback leaves no partial account');
    assert.equal(
      (await store.pool.query(`SELECT count(*)::int AS n FROM ${reservations}`)).rows[0].n,
      beforeReservations, 'rollback leaves no partial reservation');

    console.log('economic accounting schema PostgreSQL test passed');
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
