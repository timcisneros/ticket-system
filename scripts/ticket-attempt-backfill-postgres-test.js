#!/usr/bin/env node
'use strict';

// Applies the historical schema through migration 038, seeds only shapes that
// existed before explicit Ticket-attempt authority, and then exercises the real
// migration runner. No immutable Run/plan/evidence body is rewritten.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { inspectTicketAttemptBackfill } = require('../persistence/postgres/ticket-attempt-backfill');
const {
  buildDeclaredWorkSnapshotFromFields
} = require('../runtime/declared-work-contract');
const {
  buildPlanningProvenance
} = require('../runtime/structured-allocation-planning-contract');
const {
  buildLeafDeclaredWorkSnapshot,
  buildLeafRunBinding
} = require('../runtime/structured-allocation-leaf-run-contract');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required for the Ticket-attempt backfill test');
  process.exit(1);
}

const MIGRATIONS = path.join(__dirname, '../persistence/postgres/migrations');
const ACTOR = 'ticket-attempt-backfill-postgres-test';

function schemaName(suffix) {
  return `ticket_attempt_backfill_${suffix}_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
}

async function initializeThrough038(store) {
  const client = await store.pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${store.schemaSql}`);
    await client.query(`CREATE TABLE ${store.table('schema_migrations')} (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
    const files = fs.readdirSync(MIGRATIONS)
      .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 38)
      .sort();
    assert.equal(files.length, 38, 'the historical fixture must stop exactly at migration 038');
    for (const version of files) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO ${store.schemaSql}, public`);
        await client.query(fs.readFileSync(path.join(MIGRATIONS, version), 'utf8'));
        await client.query(
          `INSERT INTO ${store.table('schema_migrations')} (version) VALUES ($1)`,
          [version]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

async function withPre039(suffix, body) {
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: schemaName(suffix) });
  try {
    await initializeThrough038(store);
    return await body(store);
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) { /* best effort */ }
    await store.close();
  }
}

async function createAgent(store, name) {
  return (await store.createConfiguredAgent({
    value: { name, provider: 'openai', model: 'provider-free-fixture', apiKey: '' },
    changedBy: ACTOR
  })).agent;
}

async function createTicket(store, agent, objective) {
  return store.createTicket({
    objective,
    status: 'in_progress',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    executionMode: 'agent'
  });
}

async function reserveRunId(store) {
  const result = await store.pool.query(
    `SELECT nextval(pg_get_serial_sequence($1, 'id'))::bigint AS id`,
    [`${store.schema}.runs`]
  );
  return Number(result.rows[0].id);
}

async function insertHistoricalRun(store, {
  id = null,
  ticketId,
  agentId,
  status = 'pending',
  executionMode = 'agent',
  body = {},
  createdAt,
  completedAt = null
}) {
  const runId = id || await reserveRunId(store);
  await store.pool.query(
    `INSERT INTO ${store.table('runs')}
       (id, ticket_id, agent_id, status, execution_mode, current_phase,
        body, created_at, updated_at, started_at, completed_at)
     OVERRIDING SYSTEM VALUE
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8,
             CASE WHEN $4 = 'pending' THEN NULL ELSE $8::timestamptz END,
             $9::timestamptz)`,
    [
      runId, ticketId, agentId, status, executionMode,
      ['completed', 'failed', 'interrupted'].includes(status) ? 'terminalization' : 'planning',
      body, createdAt, completedAt
    ]
  );
  return runId;
}

async function addMinimalTerminalEvidence(store, { runId, ticketId, at }) {
  // Migration 002's trigger functions intentionally resolve sibling helpers
  // through the runtime schema. Use the store transaction boundary so this
  // historical fixture remains isolated on a genuinely fresh database rather
  // than inheriting an unrelated public-schema helper.
  await store.withTransaction(async client => {
    await client.query(
      `INSERT INTO ${store.table('replay_snapshots')}
         (run_id, ticket_id, snapshot, snapshot_hash, finalized_at)
       VALUES ($1, $2, '{}'::jsonb, $3, $4)`,
      [runId, ticketId, 'a'.repeat(64), at]
    );
    await client.query(
      `INSERT INTO ${store.table('events')}
         (id, schema_version, ts, type, ticket_id, run_id, seq, prev_hash, hash, payload)
       VALUES ($1, 1, $2, 'run.terminalized', $3, $4, 0, NULL, $5, '{}'::jsonb)`,
      [crypto.randomUUID(), at, ticketId, runId, 'b'.repeat(64)]
    );
  });
}

async function snapshotAllocationPlanRows(store) {
  return (await store.pool.query(
    `SELECT id::text AS id,
            ticket_id::text AS ticket_id,
            status,
            body::text AS body,
            revision::text AS revision,
            created_at::text AS created_at,
            updated_at::text AS updated_at
     FROM ${store.table('allocation_plans')}
     ORDER BY id`
  )).rows;
}

async function snapshotAllocationPlanStorageContract(store) {
  const relation = `${store.schema}.allocation_plans`;
  const [table, columns, constraints, indexes, triggers, identitySequence] = await Promise.all([
    store.pool.query(
      `SELECT namespace.nspname AS schema_name,
              relation.relname AS table_name,
              relation.relkind,
              relation.relpersistence,
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              pg_get_userbyid(relation.relowner) AS owner
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relname = 'allocation_plans'`,
      [store.schema]
    ),
    store.pool.query(
      `SELECT ordinal_position,
              column_name,
              data_type,
              udt_name,
              is_nullable,
              column_default,
              is_identity,
              identity_generation,
              is_generated,
              generation_expression
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'allocation_plans'
       ORDER BY ordinal_position`,
      [store.schema]
    ),
    store.pool.query(
      `SELECT constraint_record.conname AS name,
              constraint_record.contype AS type,
              constraint_record.condeferrable AS deferrable,
              constraint_record.condeferred AS initially_deferred,
              constraint_record.convalidated AS validated,
              pg_get_constraintdef(constraint_record.oid, true) AS definition
       FROM pg_constraint AS constraint_record
       WHERE constraint_record.conrelid = $1::regclass
       ORDER BY constraint_record.conname`,
      [relation]
    ),
    store.pool.query(
      `SELECT indexname AS name, indexdef AS definition
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'allocation_plans'
       ORDER BY indexname`,
      [store.schema]
    ),
    store.pool.query(
      `SELECT trigger_record.tgname AS name,
              trigger_record.tgenabled AS enabled,
              pg_get_triggerdef(trigger_record.oid, true) AS definition
       FROM pg_trigger AS trigger_record
       WHERE trigger_record.tgrelid = $1::regclass
         AND NOT trigger_record.tgisinternal
       ORDER BY trigger_record.tgname`,
      [relation]
    ),
    store.pool.query(`SELECT pg_get_serial_sequence($1, 'id') AS name`, [relation])
  ]);
  return {
    table: table.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    identitySequence: identitySequence.rows
  };
}

async function main() {
  let assertions = 0;
  const equal = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };
  const ok = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };

  await withPre039('valid', async store => {
    const agent = await createAgent(store, 'Backfill Agent');
    const peer = await createAgent(store, 'Backfill Peer');

    // A settled singleton followed by an unsettled singleton is the historical
    // retry/rerun shape. Ordering is verified, never used as membership identity.
    const retryTicket = await createTicket(store, agent, 'historical retry ordering');
    const firstAt = '2026-08-01T00:00:00.000Z';
    const firstDone = '2026-08-01T00:01:00.000Z';
    const firstRunId = await insertHistoricalRun(store, {
      ticketId: retryTicket.id, agentId: agent.id, status: 'failed',
      createdAt: firstAt, completedAt: firstDone
    });
    await addMinimalTerminalEvidence(store, {
      runId: firstRunId, ticketId: retryTicket.id, at: firstDone
    });
    const retryRunId = await insertHistoricalRun(store, {
      ticketId: retryTicket.id, agentId: agent.id,
      createdAt: '2026-08-01T00:02:00.000Z'
    });

    // Allocation Plan v1 is authoritative historical grouping.
    const v1Ticket = await createTicket(store, agent, 'historical v1 wave');
    const v1 = await store.createAllocationPlan({
      plan: {
        ticketId: v1Ticket.id,
        status: 'pending',
        mode: 'owned_paths',
        items: [
          { assignedAgentId: agent.id, ownedOutputPaths: ['v1/alpha'] },
          { assignedAgentId: peer.id, ownedOutputPaths: ['v1/beta'] }
        ]
      }
    });
    const v1Opened = '2026-08-02T00:00:00.000Z';
    const v1RunIds = [
      await insertHistoricalRun(store, {
        ticketId: v1Ticket.id, agentId: agent.id, createdAt: v1Opened,
        body: { allocationPlanId: v1.id, ticketOpenedAt: v1Opened }
      }),
      await insertHistoricalRun(store, {
        ticketId: v1Ticket.id, agentId: peer.id, createdAt: v1Opened,
        body: { allocationPlanId: v1.id, ticketOpenedAt: v1Opened }
      })
    ];

    // Historical v2 uses exact, hash-validated leaf bindings as compatibility
    // membership. It remains unsettled, so no aggregate decision is invented.
    const v2Ticket = await createTicket(store, agent, 'historical v2 leaf set');
    const parent = buildDeclaredWorkSnapshotFromFields({
      objective: { text: 'Produce two isolated historical outputs', provenance: 'ticket-authored' },
      expectedOutputs: [{
        kind: 'workflow-artifact', declaration: 'Historical output artifacts', provenance: 'workflow-defined'
      }],
      successCriteria: [{
        kind: 'text', declaration: 'Each historical output is inspectable', provenance: 'ticket-authored'
      }],
      evidenceRequirements: []
    });
    const v2 = await store.createAllocationPlan({
      plan: {
        version: 2,
        ticketId: v2Ticket.id,
        mode: 'owned_paths',
        status: 'pending',
        parentDeclaredWorkSnapshot: parent,
        sharedConstraints: [],
        items: [{
          assignedAgentId: agent.id,
          ownedOutputPaths: ['v2/alpha'],
          objective: { text: 'Produce alpha', provenance: 'validated-model-contract' },
          expectedOutputs: [{
            kind: 'workflow-artifact', declaration: 'v2/alpha/result.txt', provenance: 'workflow-defined'
          }],
          successCriteria: [{
            kind: 'text', declaration: 'Alpha output is inspectable', provenance: 'ticket-authored'
          }], evidenceRequirements: []
        }, {
          assignedAgentId: peer.id,
          ownedOutputPaths: ['v2/beta'],
          objective: { text: 'Produce beta', provenance: 'validated-model-contract' },
          expectedOutputs: [{
            kind: 'workflow-artifact', declaration: 'v2/beta/result.txt', provenance: 'workflow-defined'
          }],
          successCriteria: [{
            kind: 'text', declaration: 'Beta output is inspectable', provenance: 'ticket-authored'
          }], evidenceRequirements: []
        }]
      }
    });
    const planningAttemptId = crypto.randomUUID();
    const admittedAt = '2026-08-03T00:00:00.000Z';
    const provenance = buildPlanningProvenance({
      attemptId: planningAttemptId,
      plannerAgentId: agent.id,
      provider: 'openai',
      model: 'provider-free-fixture',
      planningAuthoritySnapshotHash: '1'.repeat(64),
      parentDeclaredWorkHash: parent.contractHash,
      requestHash: '2'.repeat(64),
      responseHash: '3'.repeat(64),
      proposalHash: '4'.repeat(64),
      planHash: v2.planHash,
      admittedAt
    });
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = body || $2::jsonb, revision = revision + 1, updated_at = clock_timestamp()
       WHERE id = $1`,
      [v2.id, { planningProvenance: provenance }]
    );
    const v2RunIds = [];
    for (const item of v2.items) {
      const runId = await reserveRunId(store);
      const declaredWork = buildLeafDeclaredWorkSnapshot(item, {
        sharedConstraints: v2.sharedConstraints
      });
      const binding = buildLeafRunBinding({
        ticketId: v2Ticket.id,
        allocationPlanId: v2.id,
        planHash: v2.planHash,
        allocationItemId: item.allocationItemId,
        assignedAgentId: item.assignedAgentId,
        itemDeclaredWorkHash: declaredWork.contractHash,
        ownedOutputPaths: item.ownedOutputPaths,
        parentDeclaredWorkHash: parent.contractHash,
        planningAttemptId,
        planningAdmissionHash: provenance.admissionHash,
        runId,
        admittedAt
      });
      await insertHistoricalRun(store, {
        id: runId,
        ticketId: v2Ticket.id,
        agentId: item.assignedAgentId,
        createdAt: admittedAt,
        body: {
          allocationPlanId: v2.id,
          allocationItemId: item.allocationItemId,
          ticketOpenedAt: admittedAt,
          declaredWorkSnapshot: declaredWork,
          leafRunBinding: binding
        }
      });
      v2RunIds.push(runId);
    }

    const allocationPlansBefore = await snapshotAllocationPlanRows(store);
    equal(allocationPlansBefore.length, 2,
      'the compatibility fixture contains one persisted v1 plan and one persisted v2 plan');
    equal(allocationPlansBefore.map(row => {
      const storedBody = JSON.parse(row.body);
      return {
        id: row.id,
        version: Object.prototype.hasOwnProperty.call(storedBody, 'version')
          ? storedBody.version
          : 1,
        hasPlanningProvenance: storedBody.planningProvenance !== undefined,
        planHash: storedBody.planHash || null
      };
    }), [
      { id: String(v1.id), version: 1, hasPlanningProvenance: false, planHash: null },
      { id: String(v2.id), version: 2, hasPlanningProvenance: true, planHash: v2.planHash }
    ], 'the stored rows expose the actual historical v1 and hash-bound v2 authority shapes');
    const allocationPlanStorageBefore = await snapshotAllocationPlanStorageContract(store);

    const before = await inspectTicketAttemptBackfill(store);
    equal(before.runCount, 6, 'preflight classifies all six historical Runs');
    equal(before.attemptCount, 4, 'preflight projects four exact historical attempts');
    equal(before.legacyAttemptCount, 4, 'legacy and projected attempt counts are identical');
    equal(before.classifications, {
      singleton_non_plan: 2,
      v1_plan: 1,
      historical_v2_leaf_set: 1
    }, 'preflight classifies singleton, v1, and v2 authority separately');

    const immutableBefore = await store.pool.query(
      `SELECT id, ticket_id, agent_id, status, execution_mode, body, created_at, completed_at
       FROM ${store.table('runs')} ORDER BY id`
    );
    equal(await store.migrate(), ['039_ticket_attempt_authority.sql'],
      'the real runner applies only migration 039');
    const immutableAfter = await store.pool.query(
      `SELECT id, ticket_id, agent_id, status, execution_mode, body, created_at, completed_at
       FROM ${store.table('runs')} ORDER BY id`
    );
    equal(immutableAfter.rows, immutableBefore.rows,
      'backfill changes no immutable Run evidence/body/lifecycle field');
    equal(await snapshotAllocationPlanRows(store), allocationPlansBefore,
      'migration 039 reads but does not rewrite any persisted v1/v2 Allocation Plan field');
    equal(await snapshotAllocationPlanStorageContract(store), allocationPlanStorageBefore,
      'migration 039 leaves the Allocation Plan table, columns, ownership, constraints, indexes, triggers, and identity authority exact');

    const attempts = (await store.pool.query(
      `SELECT id, ticket_id, ordinal, member_count, disposition
       FROM ${store.table('ticket_attempts')} ORDER BY ticket_id, ordinal`
    )).rows.map(row => ({
      id: Number(row.id), ticketId: Number(row.ticket_id), ordinal: Number(row.ordinal),
      memberCount: Number(row.member_count), disposition: row.disposition
    }));
    equal(attempts.length, 4, 'migration persists exactly the projected attempt count');
    const retryAttempts = attempts.filter(attempt => attempt.ticketId === retryTicket.id);
    equal(retryAttempts.map(attempt => [attempt.ordinal, attempt.memberCount, attempt.disposition]),
      [[1, 1, 'failed'], [2, 1, null]],
      'historical retry ordering becomes consecutive Ticket-scoped attempts');
    const memberships = await store.pool.query(
      `SELECT id, ticket_attempt_id FROM ${store.table('runs')} ORDER BY id`
    );
    const memberAttempt = new Map(memberships.rows.map(row => [Number(row.id), Number(row.ticket_attempt_id)]));
    equal(new Set(v1RunIds.map(id => memberAttempt.get(id))).size, 1,
      'both v1 Runs map to one exact attempt');
    equal(new Set(v2RunIds.map(id => memberAttempt.get(id))).size, 1,
      'both historical v2 leaf bindings map to one exact attempt');
    ok(memberAttempt.get(firstRunId) !== memberAttempt.get(retryRunId),
      'retry/rerun history never reuses predecessor attempt identity');
    equal(await store.countTicketAttempts(v1Ticket.id), 1,
      'durable attempt count agrees for v1');
    equal(await store.countTicketAttempts(v2Ticket.id), 1,
      'durable attempt count agrees for historical v2');
  });

  await withPre039('refusal', async store => {
    const agent = await createAgent(store, 'Ambiguous Backfill Agent');
    const ticket = await createTicket(store, agent, 'ambiguous non-plan historical wave');
    const openedAt = '2026-08-04T00:00:00.000Z';
    await insertHistoricalRun(store, {
      ticketId: ticket.id, agentId: agent.id, createdAt: openedAt,
      body: { ticketOpenedAt: openedAt }
    });
    await insertHistoricalRun(store, {
      ticketId: ticket.id, agentId: agent.id, createdAt: openedAt,
      body: { ticketOpenedAt: openedAt }
    });
    let refusal = null;
    try { await store.migrate(); } catch (error) { refusal = error; }
    ok(refusal && refusal.code === 'TICKET_ATTEMPT_BACKFILL_NON_PLAN_WAVE_AMBIGUOUS',
      'an unauthoritative multi-Run non-plan wave refuses migration');
    equal((await store.pool.query(
      'SELECT to_regclass($1) AS relation', [`${store.schema}.ticket_attempts`]
    )).rows[0].relation, null,
    'a refused backfill rolls migration 039 back in full');
    equal((await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('schema_migrations')}
       WHERE version = '039_ticket_attempt_authority.sql'`
    )).rows[0].count, 0, 'a refused backfill records no migration identity');
  });

  console.log(`\nPASS: Ticket-attempt historical backfill — ${assertions} assertions`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
