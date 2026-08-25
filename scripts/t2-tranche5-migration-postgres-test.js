#!/usr/bin/env node
'use strict';

// T2 Tranche 5 — migration 041 PostgreSQL falsification suite.
//
// Builds LEGACY six-state schemas by applying migrations 001..040 exactly as
// the repository runner does (per-file BEGIN/search_path/simple-query), plants
// durable legacy fixtures, then runs the real store.migrate() so the 041 hook
// + SQL execute under production semantics:
//
//   A. convergent cutover — every fixture materializes from AUTHORITY:
//      open+unsettled -> in_progress; stale-completed -> open;
//      failed-with-latest-completion -> completed; held child -> blocked;
//      existing 040 authority preserved byte-exact -> canceled;
//      closed-after-completed -> proven_not_canceled/completed;
//      closed-from-open -> proven_canceled + reconstructed authority;
//      plain open untouched (revision preserved);
//      counters reseeded to reality; run counters untouched; ledger records.
//   B. rollback — one ambiguous CLOSED row (no product close evidence)
//      aborts the WHOLE migration: zero data change, no ledger row.
//   C. NOWAIT contention — a concurrent writer holding a conflicting fact-
//      relation row lock aborts the migration at its FIRST statement: zero
//      data change, no ledger row, clean recovery once released.
//   D. identity drift — one tampered semantic-source digest aborts the
//      cutover at the SQL's Q1 binding check: zero data change, no ledger row.
//
// Requires TEST_DATABASE_URL pointing at an ISOLATED synthetic database.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  inspectTicketFiveStateBackfill
} = require('../persistence/postgres/t041-five-state-backfill');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'persistence', 'postgres', 'migrations');
const ACTOR = 'op';
const BASE_T = Date.parse('2026-01-01T00:00:00Z');

function migrationFilesThrough(version) {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => /^\d{3}_.*\.sql$/.test(name))
    .filter(name => Number(name.slice(0, 3)) <= version)
    .sort();
}

async function createLegacySchema(pool, schema) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // Mirror the runner: the ledger table exists before any file executes.
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
       )`);
    for (const file of migrationFilesThrough(40)) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query(
          `INSERT INTO "${schema}".schema_migrations (version) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`legacy apply ${file} failed: ${error.message}`);
      }
    }
    // Fixture principal for runs_configured_agent_fk (later migrations).
    await client.query(
      `INSERT INTO "${schema}".configured_agents
         (id, name, provider, model, created_by, updated_by)
       OVERRIDING SYSTEM VALUE VALUES (501, 't041-fixture-agent', 'openai', 'fixture', 'fixture', 'fixture')`);
  } finally {
    client.release();
  }
}

function makeFixtureApi(pool, schema) {
  let seq = 0;
  const nextUuid = () => `11111111-1111-4111-8111-${String(++seq).padStart(12, '0')}`;
  const q = (text, params) => pool.query(text, params);

  const api = {
    // T3 activation precondition: every Ticket seeded by THIS suite represents
    // a normally migratable legacy Ticket, so the fixture supplies canonical
    // requested-outcome content unless a caller overrides it. (Objective-less
    // rows would make migration 042 refuse the whole activation.)
    async ticket({ status, body = {}, authority = null, objective = `Tranche-5 fixture objective ${Math.random().toString(36).slice(2, 8)}` }) {
      const result = await q(
        `INSERT INTO "${schema}".tickets (status, body, cancellation_authority)
         VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
        [status, JSON.stringify({ objective, ...body }), authority ? JSON.stringify(authority) : null]
      );
      return Number(result.rows[0].id);
    },
    // Attempt + member Run in ONE implicit transaction (the deferred
    // membership-complete trigger fires at commit).
    async attemptRun({ ticketId, ordinal = 1, disposition = null, settledAt = null,
      runStatus = 'pending', agentId = 501 }) {
      await q('BEGIN');
      try {
        const attempt = await q(
          `INSERT INTO "${schema}".ticket_attempts
             (ticket_id, ordinal, member_count, disposition, admitted_at, settled_at)
           VALUES ($1, $2, 1, $3,
             COALESCE($4::timestamptz, clock_timestamp()),
             $5::timestamptz)
           RETURNING id`,
          [ticketId, ordinal, disposition,
            new Date(BASE_T + ordinal * 1000).toISOString(),
            settledAt ? new Date(settledAt).toISOString() : null]
        );
        const attemptId = Number(attempt.rows[0].id);
        // Terminal statuses require completed_at at INSERT; stage through
        // 'running' and finalize in the same implicit transaction.
        const stagedStatus = ['completed', 'failed', 'interrupted'].includes(runStatus)
          ? 'running'
          : runStatus;
        await q(
          `INSERT INTO "${schema}".runs
             (ticket_id, ticket_attempt_id, agent_id, status, execution_mode,
              started_at, created_at)
           VALUES ($1, $2, $3, $4, 'agent',
             CASE WHEN $4 = 'running' THEN COALESCE($5::timestamptz, clock_timestamp()) END,
             COALESCE($5::timestamptz, clock_timestamp()))`,
          [ticketId, attemptId, agentId, stagedStatus,
            new Date(BASE_T + ordinal * 1000 + 500).toISOString()]
        );
        if (disposition !== null && ['completed', 'failed'].includes(disposition)) {
          const doneAt = settledAt ? new Date(settledAt).toISOString()
            : new Date(BASE_T + ordinal * 1000 + 900).toISOString();
          await q(
            `UPDATE "${schema}".runs
             SET status = $4,
                 revision = revision + 1,
                 started_at = $2::timestamptz,
                 completed_at = $3::timestamptz,
                 current_phase = 'terminalization',
                 updated_at = $3::timestamptz
             WHERE ticket_attempt_id = $1`,
            [attemptId,
              new Date(BASE_T + ordinal * 1000 + 700).toISOString(),
              doneAt,
              disposition === 'completed' ? 'completed' : 'failed']
          );

        }
        await q('COMMIT');
        return attemptId;
      } catch (error) {
        await q('ROLLBACK');
        throw error;
      }
    },
    async event({ ticketId, type, payload, tsOffsetMs = 0, runId = null }) {
      const result = await q(
        `INSERT INTO "${schema}".events
           (id, schema_version, ts, type, ticket_id, run_id, payload)
         VALUES ($1, 1, $2::timestamptz, $3, $4, $5, $6::jsonb)
         RETURNING position`,
        [nextUuid(), new Date(BASE_T + tsOffsetMs).toISOString(),
          type, ticketId, runId, JSON.stringify(payload || {})]
      );
      return Number(result.rows[0].position);
    },
    async closeLog({ ticketId, fromStatus, operator = ACTOR, tsOffsetMs = 1000 }) {
      await q(
        `INSERT INTO "${schema}".diagnostic_logs
           (occurred_at, context_ticket_id, type, body)
         VALUES ($2::timestamptz, $1, 'ticket:status_change', $3::jsonb)`,
        [ticketId, new Date(BASE_T + tsOffsetMs + 500).toISOString(),
          JSON.stringify({
            ticketId, changedBy: operator,
            changedAt: new Date(BASE_T + tsOffsetMs + 500).toISOString(),
            fromStatus, toStatus: 'closed'
          })]
      );
    },
    async closeEvent({ ticketId, fromStatus, tsOffsetMs = 1000 }) {
      return api.event({
        ticketId,
        type: 'ticket.updated',
        tsOffsetMs,
        payload: { status: 'closed', previousStatus: fromStatus, changedBy: ACTOR }
      });
    }
  };
  return api;
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
  const pool = new Pool({ connectionString: databaseUrl });

  let assertions = 0;
  const ok = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };
  const equal = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };

  const stamp = Date.now().toString(36);
  const schemaA = `t041_conv_${stamp}`;
  const schemaB = `t041_rb_${stamp}`;
  const schemaC = `t041_lock_${stamp}`;
  const schemaD = `t041_drift_${stamp}`;

  try {
    console.log('convergent cutover');
    await createLegacySchema(pool, schemaA);
    const fx = makeFixtureApi(pool, schemaA);

    const tOpenUnsettled = await fx.ticket({ status: 'open' });
    await fx.attemptRun({ ticketId: tOpenUnsettled, runStatus: 'pending' });

    const tStaleCompleted = await fx.ticket({ status: 'completed' });
    await fx.attemptRun({ ticketId: tStaleCompleted, ordinal: 1, disposition: 'completed',
      settledAt: BASE_T + 9000, runStatus: 'completed' });
    await fx.attemptRun({ ticketId: tStaleCompleted, ordinal: 2, disposition: 'failed',
      settledAt: BASE_T + 11000, runStatus: 'failed' });

    const tFailedLatestCompleted = await fx.ticket({ status: 'failed' });
    await fx.attemptRun({ ticketId: tFailedLatestCompleted, disposition: 'completed',
      settledAt: BASE_T + 8000, runStatus: 'completed' });

    const holdTicket = await fx.ticket({ status: 'blocked', body: {
      parentTicketId: 999999, spawnedByStepId: 's1'
    } });
    await fx.event({ ticketId: holdTicket, type: 'ticket.created', tsOffsetMs: 10, payload: {
      parentTicketId: 999999, spawnPlanId: 7, spawnIdempotencyKey: `mig-hold-${holdTicket}`,
      createdBy: 'workflow:t041fixture'
    } });

    const tExistingAuthority = await fx.ticket({ status: 'open' });
    const preservedAuthority = {
      version: 1,
      ticketId: tExistingAuthority,
      authoritySource: 'operator', requestedBy: ACTOR,
      reason: 'pre-existing tranche-040 authority',
      committedAt: new Date(BASE_T + 2000).toISOString()
    };
    await pool.query(
      `UPDATE "${schemaA}".tickets
       SET cancellation_authority = $2::jsonb,
           revision = revision + 1
       WHERE id = $1`,
      [tExistingAuthority, JSON.stringify(preservedAuthority)]
    );

    const tClosedAfterCompleted = await fx.ticket({ status: 'closed' });
    await fx.attemptRun({ ticketId: tClosedAfterCompleted, disposition: 'completed',
      settledAt: BASE_T + 7000, runStatus: 'completed' });
    const closePosCompleted = await fx.closeEvent({
      ticketId: tClosedAfterCompleted, fromStatus: 'completed', tsOffsetMs: 20000
    });
    await fx.closeLog({ ticketId: tClosedAfterCompleted, fromStatus: 'completed', tsOffsetMs: 20000 });

    const tClosedFromOpen = await fx.ticket({ status: 'closed' });
    await fx.closeEvent({ ticketId: tClosedFromOpen, fromStatus: 'open', tsOffsetMs: 21000 });
    await fx.closeLog({ ticketId: tClosedFromOpen, fromStatus: 'open', tsOffsetMs: 21000 });

    const tPlainOpen = await fx.ticket({ status: 'open', body: { executionPolicy: { maxAttempts: 2 } } });
    const beforeRows = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaA}".tickets ORDER BY id`);
    const baselineRunCounters = await pool.query(
      `SELECT status, shard, count FROM "${schemaA}".runtime_status_counts WHERE entity_type='run' ORDER BY 1,2`);

    const store = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaA });
    const applied = await store.migrate();
    ok(applied.includes('041_ticket_five_state_cutover.sql'), '041 applied in the convergent schema');

    const after = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaA}".tickets ORDER BY id`);
    const byId = Object.fromEntries(after.rows.map(row => [Number(row.id), row]));

    equal(byId[tOpenUnsettled].status, 'in_progress',
      'open + latest unsettled attempt -> in_progress (authority over legacy string)');
    equal(byId[tStaleCompleted].status, 'open',
      'stale completion cannot survive a newer settled failed attempt -> open');
    equal(byId[tFailedLatestCompleted].status, 'completed',
      'failed legacy with a durable latest completion authority -> completed');
    equal(byId[holdTicket].status, 'blocked',
      'executeTicketPlan admission hold -> blocked (creation-event predicate, zero attempts)');
    equal(byId[holdTicket].cancellation_authority, null, 'held child acquires no cancellation authority');
    equal(byId[tClosedAfterCompleted].status, 'completed',
      'closed after authoritative completion -> PROVEN NOT CANCELED -> completed');
    equal(byId[tClosedFromOpen].status, 'canceled',
      'product close of unfinished work -> PROVEN CANCELED -> canceled');
    ok(byId[tClosedFromOpen].cancellation_authority !== null &&
       byId[tClosedFromOpen].cancellation_authority.authoritySource === 'historical_operator_closure' &&
       byId[tClosedFromOpen].cancellation_authority.requestedBy === ACTOR,
      'reconstructed historical authority carries deterministic provenance');
    equal(byId[tExistingAuthority].status, 'canceled',
      'existing 040 authority proves CANCELED');
    equal(JSON.stringify(byId[tExistingAuthority].cancellation_authority),
      JSON.stringify(beforeRows.rows.find(row => Number(row.id) === tExistingAuthority).cancellation_authority),
      'existing migration-040 authority preserved verbatim (never replaced/cleared)');
    equal(byId[tPlainOpen].status, 'open', 'already-converged Ticket stays open');
    equal(Number(byId[tPlainOpen].revision),
      Number(beforeRows.rows.find(row => Number(row.id) === tPlainOpen).revision),
      'unchanged Ticket keeps its exact revision (minimal write)');

    const coherence = await pool.query(
      `SELECT COUNT(*)::int AS bad FROM "${schemaA}".tickets
       WHERE (status = 'canceled') <> (cancellation_authority IS NOT NULL)`);
    equal(coherence.rows[0].bad, 0, 'canceled <=> authority coherence holds globally');

    const legacyVocabulary = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${schemaA}".tickets
       WHERE status IN ('failed','closed')`);
    equal(legacyVocabulary.rows[0].n, 0, 'zero failed/closed Ticket rows remain');

    const checkConstraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = '"${schemaA}".tickets'::regclass
         AND conname = 'tickets_status_check'`);
    ok(/canceled/.test(checkConstraint.rows[0]?.def || '') && !/closed/.test(checkConstraint.rows[0]?.def || ''),
      'five-state tickets_status_check installed');

    let rejectedLegacyCounter = false;
    try {
      await pool.query(
        `INSERT INTO "${schemaA}".runtime_status_counts (entity_type,status,shard,count)
         VALUES ('ticket','failed',255,1)`);
    } catch (error) { rejectedLegacyCounter = error.code === '23514'; }
    ok(rejectedLegacyCounter, 'counter identity rejects retired vocabulary');

    const drift = await pool.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT status, mod(id,256)::smallint AS shard, COUNT(*)::bigint AS c
         FROM "${schemaA}".tickets GROUP BY 1,2
       ) r FULL JOIN (
         SELECT status, shard, count FROM "${schemaA}".runtime_status_counts
         WHERE entity_type='ticket'
       ) c ON c.status=r.status AND c.shard=r.shard
       WHERE c.count IS DISTINCT FROM r.c OR c.count IS NULL OR r.c IS NULL`);
    equal(drift.rows[0].n, 0, 'ticket counters reseeded to exact reality');

    const runCounters = await pool.query(
      `SELECT status, shard, count FROM "${schemaA}".runtime_status_counts WHERE entity_type='run' ORDER BY 1,2`);
    equal(JSON.stringify(runCounters.rows), JSON.stringify(baselineRunCounters.rows),
      'run counters untouched by the cutover');

    const ledger = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${schemaA}".schema_migrations WHERE version LIKE '041%'`);
    equal(ledger.rows[0].n, 1, 'migration ledger records 041');
    await store.close();

    console.log('rollback on ambiguity');
    await createLegacySchema(pool, schemaB);
    const fxB = makeFixtureApi(pool, schemaB);
    const ambiguous = await fxB.ticket({ status: 'closed' }); // status-only closed: NO evidence
    const beforeB = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaB}".tickets ORDER BY id`);
    const ledgerBefore = await pool.query(
      `SELECT version FROM "${schemaB}".schema_migrations ORDER BY version`);

    const storeB = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaB });
    let refused = false;
    let refusalCode = null;
    try { await storeB.migrate(); } catch (error) {
      refused = true;
      refusalCode = error.code || (error.message || '').slice(0, 60);
    }
    ok(refused, 'one ambiguous CLOSED row aborts the whole migration');
    ok((refusalCode || '').includes('T041_BACKFILL_REFUSED') ||
       /ambiguous|T041/.test(refusalCode || ''), `refusal is the hook's own refusal (${refusalCode})`);
    await storeB.close();

    const afterB = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaB}".tickets ORDER BY id`);
    equal(JSON.stringify(afterB.rows), JSON.stringify(beforeB.rows),
      'rolled-back data is byte-identical (statuses/revisions/authorities untouched)');
    const ledgerAfter = await pool.query(
      `SELECT version FROM "${schemaB}".schema_migrations ORDER BY version`);
    equal(JSON.stringify(ledgerAfter.rows), JSON.stringify(ledgerBefore.rows),
      'rolled-back ledger has no 041 row and no partial applications');
    ok(!ledgerAfter.rows.some(row => row.version.startsWith('041')), 'confirmed: no 041 in rolled-back ledger');

    // ── C. NOWAIT contention refuses with zero effects ─────────────────────
    // A concurrent UNCOMMITTED WRITER on any locked fact relation holds
    // RowExclusiveLock, which conflicts with the hook's SHARE ROW EXCLUSIVE
    // NOWAIT: the migration must abort at its FIRST statement — before
    // classification, before any write, without a ledger row. (A bare
    // SELECT ... FOR UPDATE takes only RowShareLock, which deliberately does
    // NOT conflict; writers are what H1 quiesces.) Releasing the writer lets
    // the real runner complete, proving nothing partial survived.
    console.log('NOWAIT contention refusal');
    await createLegacySchema(pool, schemaC);
    const fxC = makeFixtureApi(pool, schemaC);
    const contentionTicket = await fxC.ticket({ status: 'open' });
    const beforeC = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaC}".tickets ORDER BY id`);
    const ledgerBeforeC = await pool.query(
      `SELECT version FROM "${schemaC}".schema_migrations ORDER BY version`);

    const blocker = await pool.connect();
    const storeC = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaC });
    let lockRefused = false;
    let lockErrorCode = null;
    try {
      await blocker.query('BEGIN');
      // The exact conflicting writer mode: RowExclusiveLock on a locked fact
      // relation (what uncommitted DML holds), with zero row effects.
      await blocker.query(`LOCK TABLE "${schemaC}".tickets IN ROW EXCLUSIVE MODE`);
      try {
        await storeC.migrate();
      } catch (error) {
        lockRefused = true;
        lockErrorCode = error.code || null;
        ok(error.code === '55P03' ||
           /could not obtain lock|nowait/i.test(String(error.message || '')),
          `the refusal is the NOWAIT failure itself (${(error.message || '').slice(0, 80)})`);
      }
      ok(lockRefused, 'a concurrent fact-relation writer aborts the migration immediately');
      if (lockRefused) {
        ok(lockErrorCode === '55P03' || lockErrorCode === null,
          `lock_nowait surfaced its own error class (${lockErrorCode})`);
      }
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
    }

    const afterC = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaC}".tickets ORDER BY id`);
    equal(JSON.stringify(afterC.rows), JSON.stringify(beforeC.rows),
      'contended migration left ticket data byte-identical');
    const ledgerAfterC = await pool.query(
      `SELECT version FROM "${schemaC}".schema_migrations ORDER BY version`);
    equal(JSON.stringify(ledgerAfterC.rows), JSON.stringify(ledgerBeforeC.rows),
      'contended migration left the ledger untouched (no 041 row)');
    ok(!ledgerAfterC.rows.some(row => row.version.startsWith('041')),
      'confirmed: no 041 ledger row after lock refusal');

    const appliedAfterContention = await storeC.migrate();
    ok(appliedAfterContention.includes('041_ticket_five_state_cutover.sql'),
      'releasing the writer lets the real runner complete 041 cleanly');
    ok((await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${schemaC}".schema_migrations WHERE version LIKE '041%'`
    )).rows[0].n === 1, 'and the recovered run records exactly one 041 ledger row');
    await storeC.close();

    // ── D. semantic identity drift refuses before any mutation ────────────
    // The SQL file pins the digests of every semantic source capable of
    // changing 041's result. Tampering ONE recorded digest must abort the
    // cutover at Q1 — before Q2 drops anything and before Q4 writes — with
    // zero data change and no ledger insertion.
    console.log('identity drift refusal');
    await createLegacySchema(pool, schemaD);
    const fxD = makeFixtureApi(pool, schemaD);
    const driftTicketA = await fxD.ticket({ status: 'open' });
    const driftTicketB = await fxD.ticket({ status: 'completed' });
    const beforeD = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaD}".tickets ORDER BY id`);
    const ledgerBeforeD = await pool.query(
      `SELECT version FROM "${schemaD}".schema_migrations ORDER BY version`);

    const driftClient = await pool.connect();
    let driftRefused = false;
    let driftMessage = '';
    try {
      await driftClient.query('BEGIN');
      await driftClient.query(`SET LOCAL search_path TO "${schemaD}", public`);
      const driftStore = new PostgresRuntimeStore({
        connectionString: databaseUrl, schema: schemaD
      });
      await inspectTicketFiveStateBackfill(driftStore, { client: driftClient });
      // Tamper a NEWLY BOUND transitive semantic source (F1): the aggregate
      // disposition authority lives in ticket-attempt-contract.js, reached
      // through the completion evaluator; its digest is now part of Q1.
      await driftClient.query(
        `UPDATE t041_identity SET actual_sha256 = $1
         WHERE label = 'ticket-attempt-contract.js'`,
        ['0'.repeat(64)]);
      try {
        await driftClient.query(fs.readFileSync(
          path.join(MIGRATIONS_DIR, '041_ticket_five_state_cutover.sql'), 'utf8'));
      } catch (error) {
        driftRefused = true;
        driftMessage = String(error.message || '');
      }
    } finally {
      await driftClient.query('ROLLBACK').catch(() => {});
      driftClient.release();
    }

    ok(driftRefused, 'one drifted semantic-source digest aborts the cutover at Q1');
    ok(driftMessage.includes('041 source identity drift') &&
       driftMessage.includes('ticket-attempt-contract.js'),
      `the refusal names the drifted TRANSITIVE source (${driftMessage.slice(0, 160)})`);
    const afterD = await pool.query(
      `SELECT id, status, revision, cancellation_authority FROM "${schemaD}".tickets ORDER BY id`);
    equal(JSON.stringify(afterD.rows), JSON.stringify(beforeD.rows),
      'drift refusal left ticket data byte-identical (legacy statuses intact)');
    const ledgerAfterD = await pool.query(
      `SELECT version FROM "${schemaD}".schema_migrations ORDER BY version`);
    equal(JSON.stringify(ledgerAfterD.rows), JSON.stringify(ledgerBeforeD.rows),
      'drift refusal inserted no ledger row');
    ok(!ledgerAfterD.rows.some(row => row.version.startsWith('041')),
      'confirmed: no 041 in the drifted-run ledger');
    ok(afterD.rows.every(row => row.status !== 'canceled' || row.cancellation_authority),
      'no half-converted vocabulary survived the drift refusal');

    console.log(`\n${assertions} assertions passed`);
  } finally {
    for (const schema of [schemaA, schemaB, schemaC, schemaD]) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
