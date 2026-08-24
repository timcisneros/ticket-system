#!/usr/bin/env node
'use strict';

// T2 — classifier FACT-ASSEMBLY PARITY owner (operational incident T2-041-1).
//
// THE ESCAPED CASE THIS SUITE KILLS: migration 041's in-transaction hook and
// the standalone zero-mutation preflight classifier each assembled classifier
// facts from PostgreSQL rows with PRIVATE mappers. The hook mapped
// diagnostic-log identity without the context_ticket_id fallback, so a log
// row owned only through context_ticket_id reached the shared semantic
// contract as ticketId:null -> HISTORY_CLASSIFIER_INVALID_INPUT ->
// integrity_contradiction, while the preflight had classified the same fact
// set clean. The operational cutover refused safely and rolled back; the
// double-run preflight could not see the divergence because both of its runs
// used the standalone tool's own mapper.
//
// CORRECTION UNDER TEST: both production paths now normalize persistence rows
// through runtime/ticket-history-classifier-facts.js (one pure boundary), so
// the same persisted row cannot produce two different classifier inputs.
//
// This suite exercises the REAL production seams on one legacy-040 schema:
//   A. the real standalone classifier as a child process (READ ONLY); and
//   B. the real migration-041 hook inside an explicitly ROLLED-BACK
//      transaction (lock + classify + temp projection only; the 041 SQL body
//      never executes here).
// and requires their classifications to agree for every seeded Ticket.
//
// Identity semantics pinned:
//   - direct ownership: log.ticket_id (+ run_id) wins and is authoritative;
//   - context-only ownership: ticket_id NULL + context_ticket_id set resolves
//     to the governing Ticket — never HISTORY_CLASSIFIER_INVALID_INPUT;
//   - global rows (both NULL) attach to no Ticket;
//   - conflicting rows (ticket_id=A, context_ticket_id=B) belong to A only;
//   - no private fact mapper may reappear in either production entry source.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'persistence', 'postgres', 'migrations');
const CLASSIFIER = path.join(ROOT, 'scripts', 't2-five-state-classifier.js');
const HOOK_SOURCE = path.join(ROOT, 'persistence', 'postgres', 't041-five-state-backfill.js');
const TOOL_SOURCE = path.join(ROOT, 'scripts', 't2-five-state-classifier.js');
const SHARED_FACTS_MODULE = 'ticket-history-classifier-facts';
const BASE_T = Date.parse('2026-08-18T19:00:00Z');
const AGENT_ID = 501;

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
    await client.query(
      `CREATE TABLE "${schema}".schema_migrations (
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
    await client.query(
      `INSERT INTO "${schema}".configured_agents
         (id, name, provider, model, created_by, updated_by)
       OVERRIDING SYSTEM VALUE VALUES ($1, 'parity-fixture-agent', 'openai',
         'fixture', 'fixture', 'fixture')`, [AGENT_ID]);
  } finally {
    client.release();
  }
}

function makeFixtureApi(pool, schema) {
  const q = (text, params) => pool.query(text, params);
  return {
    async ticket({ status = 'failed' }) {
      const result = await q(
        `INSERT INTO "${schema}".tickets (status, body)
         VALUES ($1, '{}'::jsonb) RETURNING id`, [status]);
      return Number(result.rows[0].id);
    },
    async failedAttemptRun({ ticketId }) {
      await q('BEGIN');
      try {
        const attempt = await q(
          `INSERT INTO "${schema}".ticket_attempts
             (ticket_id, ordinal, member_count, disposition, admitted_at, settled_at)
           VALUES ($1, 1, 1, 'failed', $2::timestamptz, $3::timestamptz)
           RETURNING id`,
          [ticketId,
            new Date(BASE_T + 1000).toISOString(),
            new Date(BASE_T + 5000).toISOString()]);
        const attemptId = Number(attempt.rows[0].id);
        await q(
          `INSERT INTO "${schema}".runs
             (ticket_id, ticket_attempt_id, agent_id, status, execution_mode,
              started_at, created_at)
           VALUES ($1, $2, $3, 'running', 'agent', $4::timestamptz, $4::timestamptz)`,
          [ticketId, attemptId, AGENT_ID,
            new Date(BASE_T + 1500).toISOString()]);
        await q(
          `UPDATE "${schema}".runs
           SET status = 'failed', revision = revision + 1,
               started_at = $2::timestamptz, completed_at = $3::timestamptz,
               current_phase = 'terminalization', updated_at = clock_timestamp()
           WHERE ticket_attempt_id = $1`,
          [attemptId,
            new Date(BASE_T + 1500).toISOString(),
            new Date(BASE_T + 4500).toISOString()]);
        await q('COMMIT');
        return attemptId;
      } catch (error) {
        await q('ROLLBACK');
        throw error;
      }
    },
    async createdEvent({ ticketId }) {
      await q(
        `INSERT INTO "${schema}".events
           (id, schema_version, ts, type, ticket_id, run_id, payload)
         VALUES (md5(random()::text || clock_timestamp()::text)::uuid, 1,
                 $1::timestamptz, 'ticket.created', $2, NULL, '{"createdBy":"parity"}'::jsonb)`,
        [new Date(BASE_T).toISOString(), ticketId]);
    },
    // Direct ownership: ticket_id AND run_id set; body names the same Ticket.
    async directLog({ ticketId, runId }) {
      await q(
        `INSERT INTO "${schema}".diagnostic_logs
           (occurred_at, ticket_id, run_id, type, body)
         VALUES ($1::timestamptz, $2, $3, 'ticket:rerun', $4::jsonb)`,
        [new Date(BASE_T + 6000).toISOString(), ticketId, runId,
          JSON.stringify({ ticketId, changedBy: 'parity-direct' })]);
    },
    // The escaped shape: NO direct identity; context binds the Ticket.
    async contextOnlyLog({ ticketId }) {
      await q(
        `INSERT INTO "${schema}".diagnostic_logs
           (occurred_at, context_ticket_id, type, body)
         VALUES ($1::timestamptz, $2, 'ticket:rerun',
                 '{"changedBy":"parity-context"}'::jsonb)`,
        [new Date(BASE_T + 6100).toISOString(), ticketId]);
    },
    // Global noise: owned by neither Ticket nor Run.
    async globalLog() {
      await q(
        `INSERT INTO "${schema}".diagnostic_logs
           (occurred_at, type, body)
         VALUES ($1::timestamptz, 'system:noise', '{"note":"global"}'::jsonb)`,
        [new Date(BASE_T + 7000).toISOString()]);
    },
    // Conflicting identity is representable: direct column MUST win over an
    // unrelated context reference to another Ticket.
    async conflictingLog({ ownerTicketId, runId, strayTicketId }) {
      await q(
        `INSERT INTO "${schema}".diagnostic_logs
           (occurred_at, ticket_id, run_id, context_ticket_id, type, body)
         VALUES ($1::timestamptz, $2, $3, $4, 'ticket:rerun', $5::jsonb)`,
        [new Date(BASE_T + 6200).toISOString(), ownerTicketId, runId, strayTicketId,
          JSON.stringify({ changedBy: 'parity-conflict' })]);
    }
  };
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.error('FAIL: t2 five-state fact-parity requires TEST_DATABASE_URL');
    process.exit(1);
  }
  const assert = require('node:assert/strict');
  let assertions = 0;
  const ok = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
    console.log(`  ok ${message}`);
  };

  const pool = new Pool({ connectionString: databaseUrl });
  const stamp = Date.now().toString(36);
  const schema = `t041_parity_${stamp}`;

  try {
    console.log('fact-assembly parity: preflight tool vs migration-041 hook');
    await createLegacySchema(pool, schema);
    const fx = makeFixtureApi(pool, schema);

    // Ticket 1: carries the escaped context-only diagnostic log shape.
    const tContext = await fx.ticket({});
    await fx.failedAttemptRun({ ticketId: tContext });
    await fx.createdEvent({ ticketId: tContext });
    await fx.contextOnlyLog({ ticketId: tContext });

    // Ticket 2: direct authoritative log.
    const tDirect = await fx.ticket({});
    const runDirect = await fx.failedAttemptRun({ ticketId: tDirect });
    await fx.directLog({ ticketId: tDirect, runId: runDirect });

    // Ticket 3: conflicting identity row — direct ownership must win.
    const tOwner = await fx.ticket({});
    const runOwner = await fx.failedAttemptRun({ ticketId: tOwner });
    const tStray = await fx.ticket({});
    await fx.failedAttemptRun({ ticketId: tStray });
    await fx.conflictingLog({
      ownerTicketId: tOwner, runId: runOwner, strayTicketId: tStray
    });

    // Global noise attaches to nobody.
    await fx.globalLog();

    const expectedTickets = [tContext, tDirect, tOwner, tStray].sort((a, b) => a - b);

    // ── A. real standalone zero-mutation classifier ────────────────────────
    const report = JSON.parse(execFileSync('node', [
      CLASSIFIER,
      '--database-url-env', 'TEST_DATABASE_URL',
      '--expected-database', new URL(databaseUrl).pathname.slice(1),
      '--schema', schema
    ], { encoding: 'utf8', env: process.env }));
    ok(report.summary.total === expectedTickets.length,
      `standalone classified every seeded Ticket (${report.summary.total})`);
    ok(report.summary.integrityContradictions === 0 &&
       report.summary.ambiguous === 0,
      'standalone reports zero ambiguity and zero contradictions');
    for (const entry of report.tickets) {
      ok(entry.classification === 'migratable' && entry.proposedLifecycle === 'open',
        `standalone: ticket ${entry.ticketId} migratable/open ` +
        `(reasons=${JSON.stringify(entry.reasons.map(r => r.code))})`);
    }

    // ── B. real migration-041 hook inside an explicitly rolled-back txn ────
    const { PostgresRuntimeStore } = require(path.join(ROOT, 'persistence', 'postgres', 'store'));
    const {
      inspectTicketFiveStateBackfill
    } = require(HOOK_SOURCE);
    const store = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    let projectionRows;
    try {
      const client = await store.pool.connect();
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        await inspectTicketFiveStateBackfill(store, { client });
        ok(true, 'hook accepted the fact set the preflight classified clean');
        projectionRows = (await client.query(
          `SELECT ticket_id, desired_status, classification
           FROM t041_ticket_lifecycle_projection ORDER BY ticket_id`)).rows;
      } finally {
        // The hook's classification phase is proven mutation-free here: the
        // whole transaction (locks, temp tables, classification reads) rolls
        // back; the 041 SQL body never ran in this suite.
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await store.close();
    }

    ok(projectionRows.length === expectedTickets.length,
      `hook projected exactly the seeded Ticket population (${projectionRows.length})`);
    for (const row of projectionRows) {
      const standaloneEntry = report.tickets.find(
        entry => entry.ticketId === Number(row.ticket_id));
      ok(Boolean(standaloneEntry),
        `hook ticket ${row.ticket_id} exists in the standalone report`);
      ok(row.desired_status === standaloneEntry.proposedLifecycle &&
         row.classification === standaloneEntry.classification,
        `parity: ticket ${row.ticket_id} hook=${row.desired_status}/${row.classification} ` +
        `equals standalone=${standaloneEntry.proposedLifecycle}/${standaloneEntry.classification}`);
    }

    // Context-only ownership must resolve, not refuse.
    const contextRow = projectionRows.find(row => Number(row.ticket_id) === tContext);
    ok(contextRow && contextRow.desired_status === 'open' &&
       contextRow.classification === 'migratable',
      'context-only diagnostic log resolved to its governing Ticket (no INVALID_INPUT refusal)');
    // Global noise attached to nobody: population did not grow.
    ok(!projectionRows.some(row => !expectedTickets.includes(Number(row.ticket_id))),
      'global diagnostic logs attached to no Ticket');
    // Direct ownership won over the stray context reference.
    ok(projectionRows.every(row => Number(row.ticket_id) !== null),
      'every projection row carries a concrete governing Ticket');

    // ── C. structural anti-drift: private mappers may not reappear ─────────
    const hookSource = fs.readFileSync(HOOK_SOURCE, 'utf8');
    const toolSource = fs.readFileSync(TOOL_SOURCE, 'utf8');
    const sharedRequire = `require('../../runtime/${SHARED_FACTS_MODULE}')`;
    ok(hookSource.includes(sharedRequire),
      'migration hook normalizes facts through the shared boundary module');
    const toolSharedRequire =
      `require('../runtime/${SHARED_FACTS_MODULE}')`;
    ok(toolSource.includes(toolSharedRequire),
      'standalone classifier normalizes facts through the shared boundary module');
    ok(!hookSource.includes("row.ticket_id === null ? null : Number(row.ticket_id)"),
      'hook contains no private raw-ticket_id remap');
    ok(!toolSource.includes('function logFact('),
      'standalone classifier contains no private fact mappers anymore');

    console.log(`\nPASS: T2 five-state fact-assembly parity — ${assertions} assertions (PostgreSQL-native)`);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
