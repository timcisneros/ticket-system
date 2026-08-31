#!/usr/bin/env node
'use strict';

// T3 — objective-revision kernel PostgreSQL owner.
//
// Exercises the frozen kernel semantics against real disposable PostgreSQL:
// activation-baseline migration (canonicality refusals, atomicity,
// idempotency, generic-revision preservation, guard restoration), guarded
// N->N+1 revision (no-op / unsettled-attempt / structured-delegation /
// cancellation refusals), admission fail-closed integrity (pointer/head/
// content drift), authoritative Run stamping with per-attempt uniformity
// (pre-lock drafts cannot dictate identity), T2 blocker and Ticket-wide
// maxAttempts preservation, concurrency serialization, pre-T3 Run behavior,
// and completion/evidence compatibility.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'persistence', 'postgres', 'migrations');
const BASE_T = Date.parse('2026-08-18T19:00:00Z');
const AGENT_ID = 7001;
const REV_EVENT = 'ticket.objective_revised';

let assertions = 0;
function ok(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  assertions += 1;
  console.log(`  ok ${message}`);
}

function migrationFilesThrough(version) {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => /^\d{3}_.*\.sql$/.test(name))
    .filter(name => Number(name.slice(0, 3)) <= version)
    .sort();
}

async function createSchemaThrough(pool, schema, version) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      `CREATE TABLE "${schema}".schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
    for (const file of migrationFilesThrough(version)) {
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
    // Configured agents satisfy the runs agent-integrity FK for seeds and
    // admissions (distinct agents avoid the one-active-run-per-agent rule).
    for (let index = 0; index < 64; index += 1) {
      const agentId = AGENT_ID + index;
      await client.query(
        `INSERT INTO "${schema}".configured_agents
           (id, name, provider, model, created_by, updated_by)
         OVERRIDING SYSTEM VALUE VALUES ($1::bigint, 't3-fixture-agent-' || $1::text,
           'openai', 'fixture', 'fixture', 'fixture')`, [agentId]);
    }
  } finally {
    client.release();
  }
}

// Manually replays migration 041 INCLUDING its in-transaction hook, mirroring
// the canonical runner sequence (BEGIN -> SET LOCAL -> hook -> SQL -> ledger
// -> COMMIT), for scenarios that must observe the post-041/pre-042 world.
async function applyMigration041Manually(pool, schema) {
  const {
    inspectTicketFiveStateBackfill,
    sourceDigests
  } = require('../persistence/postgres/t041-five-state-backfill');
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');
  const store = new PostgresRuntimeStore({ connectionString: process.env.TEST_DATABASE_URL, schema });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await inspectTicketFiveStateBackfill(store, { client });
    await client.query(fs.readFileSync(
      path.join(MIGRATIONS_DIR, '041_ticket_five_state_cutover.sql'), 'utf8'));
    await client.query(
      `INSERT INTO "${schema}".schema_migrations (version)
       VALUES ('041_ticket_five_state_cutover.sql')`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    void sourceDigests;
    await store.close().catch(() => {});
  }
}

async function seedLegacyTicket(pool, schema, { objective, acceptanceCriteria = null }) {
  const result = await pool.query(
    `INSERT INTO "${schema}".tickets (status, body)
     VALUES ('open', $1::jsonb) RETURNING id, revision`,
    [JSON.stringify({ objective, ...(acceptanceCriteria ? { acceptanceCriteria } : {}) })]);
  return { id: Number(result.rows[0].id), revision: Number(result.rows[0].revision) };
}

async function seedLegacyRun(pool, schema, ticketId) {
  // Pre-T3 shape: attempt + terminal run written directly in one transaction
  // (the attempt membership constraint trigger is deferred to commit), no
  // revision stamps anywhere.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const attempt = await client.query(
      `INSERT INTO "${schema}".ticket_attempts
         (ticket_id, ordinal, member_count, disposition, admitted_at, settled_at)
       VALUES ($1, 1, 1, 'failed', $2::timestamptz, $3::timestamptz)
       RETURNING id`,
      [ticketId, new Date(BASE_T).toISOString(), new Date(BASE_T + 1000).toISOString()]);
    const attemptId = Number(attempt.rows[0].id);
    await client.query(
      `INSERT INTO "${schema}".runs
         (ticket_id, ticket_attempt_id, agent_id, status, execution_mode,
          started_at, completed_at, current_phase, created_at, updated_at, body)
       VALUES ($1, $2, $3, 'failed', 'agent', $4::timestamptz, $5::timestamptz,
               'terminalization', $4::timestamptz, $5::timestamptz,
               '{"legacy":true}'::jsonb)`,
      [ticketId, attemptId, AGENT_ID,
        new Date(BASE_T + 100).toISOString(), new Date(BASE_T + 900).toISOString()]);
    await client.query('COMMIT');
    return attemptId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function headEvent(pool, schema, ticketId) {
  const result = await pool.query(
    `SELECT position, payload FROM "${schema}".events
      WHERE ticket_id = $1 AND type = $2
      ORDER BY position DESC LIMIT 1`,
    [ticketId, REV_EVENT]);
  return result.rowCount === 0 ? null : result.rows[0];
}

async function pointer(pool, schema, ticketId) {
  const result = await pool.query(
    `SELECT body->'objectiveRevision' AS p FROM "${schema}".tickets WHERE id = $1`,
    [ticketId]);
  return result.rows[0].p;
}

async function revisionEventsCount(pool, schema, ticketId) {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM "${schema}".events
      WHERE ticket_id = $1 AND type = $2`, [ticketId, REV_EVENT]);
  return result.rows[0].n;
}

async function settleAttemptAndReopen(pool, schema, store, ticketId) {
  await pool.query(
    `UPDATE "${schema}".runs
        SET status = 'failed', revision = revision + 1,
            completed_at = clock_timestamp(), current_phase = 'terminalization'
      WHERE ticket_attempt_id IN (
        SELECT id FROM "${schema}".ticket_attempts WHERE ticket_id = $1)
        AND status IN ('pending', 'running')`, [ticketId]);
  await pool.query(
    `UPDATE "${schema}".ticket_attempts
        SET disposition = 'failed', settled_at = clock_timestamp(), revision = revision + 1
      WHERE ticket_id = $1 AND disposition IS NULL`, [ticketId]);
  await pool.query(
    `UPDATE "${schema}".tickets
        SET status = 'open', revision = revision + 1, updated_at = clock_timestamp()
      WHERE id = $1`, [ticketId]);
  void store;
}

function minimalBudgetSnapshot(maxAttempts = 2) {
  const {
    buildRuntimeBudgetSnapshot
  } = require('../runtime/runtime-budget-contract');
  return buildRuntimeBudgetSnapshot({
    runtimeLimits: {
      revision: 1,
      maxAttempts,
      maxExecutionSteps: 100,
      maxModelRequestsPerRun: 100,
      maxWorkspaceOperationsPerRun: 100,
      maxProcessOperationsPerRun: 10,
      maxBrowserOperationsPerRun: 10,
      maxRuntimeDurationMs: 600000,
      maxOutputArtifactBytesPerRun: 10000000
    },
    executionPolicy: { allowParallelRuns: false }
  });
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');
  const {
    canonicalRevisionContent,
    revisionContentHash,
    IDENTITY_REGISTER
  } = require('../runtime/ticket-objective-revision-contract');
  const stamp = Date.now().toString(36);
  const pool = new Pool({ connectionString: databaseUrl });

  // ── Schema A: clean legacy baseline + kernel behavior ────────────────────
  const schemaA = `t3a_${stamp}_a`;
  await createSchemaThrough(pool, schemaA, 40);

  const legacyRevisionsBefore = {};
  const l1 = await seedLegacyTicket(pool, schemaA, { objective: 'Legacy objective one' });
  legacyRevisionsBefore[l1.id] = l1.revision;
  const hugeObjective = 'L'.repeat(25000);
  const l2 = await seedLegacyTicket(pool, schemaA, {
    objective: hugeObjective, acceptanceCriteria: 'keep going'
  });
  legacyRevisionsBefore[l2.id] = l2.revision;
  const legacyAttemptId = await seedLegacyRun(pool, schemaA, l1.id); // pre-T3 run

  console.log('activation baseline migration');
  const storeA = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaA, disposableMigrations: true });
  const applied = await storeA.migrate();
  ok(applied.includes('042_objective_revision_baseline.sql'), 'canonical runner applied 042 once');

  // D/E/X/H: baseline coherence, >20k accepted unchanged, convergence,
  // generic revisions preserved, guard restored.
  for (const legacy of [l1, l2]) {
    const ptr = await pointer(pool, schemaA, legacy.id);
    const head = await headEvent(pool, schemaA, legacy.id);
    ok(ptr && head, `legacy ticket ${legacy.id} carries event + pointer`);
    ok(ptr.number === head.payload.number && ptr.hash === head.payload.contentHash,
      `legacy ticket ${legacy.id} pointer matches chain head`);
    ok(head.payload.provenance === 't3_activation_baseline' &&
       head.payload.reasonCode === 'legacy_baseline' &&
       head.payload.previous === null && head.payload.number === 1,
      `legacy ticket ${legacy.id} baseline provenance/shape truthful`);
    ok(head.payload.actor === 'migration:042_objective_revision_baseline',
      'baseline actor is the migration identity');
    const expectedHash = revisionContentHash(canonicalRevisionContent({
      objective: legacy === l1 ? 'Legacy objective one' : hugeObjective,
      acceptanceCriteria: legacy === l1 ? null : 'keep going'
    }));
    ok(head.payload.contentHash === expectedHash,
      `baseline hash binds stored canonical content (ticket ${legacy.id})`);
    if (legacy === l2) {
      ok(head.payload.content.objective.length === 25000,
        'valid legacy objective longer than any subsystem cap baselines unchanged (E)');
    }
    const revNow = Number((await pool.query(
      `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`, [legacy.id])).rows[0].revision);
    ok(revNow === legacyRevisionsBefore[legacy.id],
      `generic tickets.revision preserved for ticket ${legacy.id} (H)`);
  }
  {
    const guard = await pool.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgname = 'tickets_revision_guard'
          AND tgrelid = '${schemaA}.tickets'::regclass AND tgenabled <> 'O'`);
    ok(guard.rows[0].n === 0, 'tickets_revision_guard restored after baseline (H)');
    const counts = await revisionEventsCount(pool, schemaA, l1.id);
    ok(counts === 1, 'exactly one baseline event per eligible Ticket');
    void legacyAttemptId;
  }

  // W: pre-T3 runs carry NO fabricated revision identity; snapshots intact.
  {
    const runRow = (await pool.query(
      `SELECT body FROM "${schemaA}".runs WHERE ticket_attempt_id = $1`, [legacyAttemptId])).rows[0];
    ok(runRow.body.objectiveRevision === undefined,
      'pre-T3 run carries no revision stamp (W)');
    ok(runRow.body.legacy === true, 'pre-T3 run body snapshots untouched (W)');
  }

  // A: human-created Ticket -> coherent revision 1.
  console.log('creation-time revision-1 establishment');
  const human = await storeA.createTicketWithEvent({
    ticket: { status: 'open', objective: 'Human objective', createdBy: 'alice' },
    eventPayload: { createdBy: 'alice' }
  });
  ok(human.created === true, 'human creation inserted');
  {
    const ptr = await pointer(pool, schemaA, human.ticket.id);
    const head = await headEvent(pool, schemaA, human.ticket.id);
    ok(ptr.number === 1 && ptr.hash === head.payload.contentHash,
      'human-created Ticket leaves creation with matching rev-1 pointer/head (A)');
    ok(head.payload.provenance === 'creation' && head.payload.actor === 'alice',
      'creation actor truthfully recorded (A)');
    ok(await revisionEventsCount(pool, schemaA, human.ticket.id) === 1,
      'exactly one revision-1 event (A)');
  }

  // B/C: workflow child spawn actor + idempotent replay.
  const childKey = `spawn-${stamp}`;
  const child = await storeA.createTicketWithEvent({
    ticket: {
      status: 'open', objective: 'Child objective',
      createdBy: 'workflow:9', spawnIdempotencyKey: childKey
    },
    eventPayload: {}
  });
  {
    const head = await headEvent(pool, schemaA, child.ticket.id);
    ok(head.payload.actor === 'workflow:9',
      'workflow child records truthful system creator actor (B)');
    const replay = await storeA.createTicketWithEvent({
      ticket: {
        status: 'open', objective: 'Child objective',
        createdBy: 'workflow:9', spawnIdempotencyKey: childKey
      },
      eventPayload: {}
    });
    ok(replay.created === false && replay.ticket.id === child.ticket.id,
      'spawn replay returns existing Ticket without duplicate (C)');
    ok(await revisionEventsCount(pool, schemaA, child.ticket.id) === 1,
      'no duplicate revision-1 on replay (C)');
  }

  // K/L: guarded N -> N+1; canonical no-op refused; generic +1 exactly.
  const t1 = human.ticket;
  const revisionBeforeK = t1.revision;
  const revised = await storeA.reviseTicketObjective({
    ticketId: t1.id,
    expectedRevision: revisionBeforeK,
    objective: 'Human objective v2',
    acceptanceCriteria: 'tests pass',
    reasonCode: 'clarification',
    reason: 'operator clarified the requested outcome',
    actor: 'bob'
  });
  ok(revised.objectiveRevision.number === 2, 'guarded N->N+1 establishes revision 2 (K)');
  ok(revised.ticket.revision === revisionBeforeK + 1,
    'generic tickets.revision advances exactly +1 on a real revision (H)');
  ok((await headEvent(pool, schemaA, t1.id)).payload.contentHash === revised.objectiveRevision.hash,
    'projection pointer equals new chain head (K)');
  await storeA.reviseTicketObjective({
    ticketId: t1.id, expectedRevision: revised.ticket.revision,
    objective: ' Human objective v2 ', acceptanceCriteria: 'tests pass',
    reasonCode: 'correction', reason: 'whitespace-only resubmission', actor: 'bob'
  }).then(() => ok(false, 'no-op should refuse')).catch(error => {
    ok(error.code === 'TICKET_OBJECTIVE_REVISION_NOOP',
      'canonical no-op revision refused (L)');
  });

  // M + S/R/Q: admission integrity, stamping, uniformity, lock serialization.
  console.log('admission fail-closed integrity + Run stamping');
  const budget = minimalBudgetSnapshot();
  const t2 = await storeA.createTicketWithEvent({
    ticket: { status: 'open', objective: 'Admission target', createdBy: 'carol' },
    eventPayload: {}
  });
  const drafts = [1, 2].map(index => ({
    ticketId: t2.ticket.id,
    agentId: AGENT_ID + index,
    executionMode: 'agent',
    runtimeBudgetSnapshot: budget,
    objectiveRevision: { number: 99, hash: 'f'.repeat(64) } // forged draft identity
  }));
  const admission = await storeA.createRunsAndStartTicket({
    ticketId: t2.ticket.id, runDrafts: drafts
  });
  ok(admission.runs.length === 2, 'attempt admitted with both member Runs');
  const stamps = admission.runs.map(run => run.objectiveRevision);
  ok(stamps.every(stampItem => stampItem.number === 1) &&
     new Set(stamps.map(stampItem => stampItem.hash)).size === 1,
    'every Run in the attempt carries ONE identical objectiveRevision (S)');
  const projectedHash = revisionContentHash(canonicalRevisionContent({
    objective: 'Admission target', acceptanceCriteria: null
  }));
  ok(stamps[0].hash === projectedHash && stamps[0].number === 1,
    'stamped identity derives from validated locked Ticket authority, not the draft (R)');

  const t2CurrentRevision = Number((await pool.query(
    `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`, [t2.ticket.id])).rows[0].revision);
  await storeA.reviseTicketObjective({
    ticketId: t2.ticket.id, expectedRevision: t2CurrentRevision,
    objective: 'attempt-spanning change', acceptanceCriteria: null,
    reasonCode: 'correction', reason: 'must refuse mid-attempt', actor: 'bob'
  }).then(() => ok(false, 'mid-attempt revision must refuse')).catch(error => {
    ok(error.code === 'TICKET_ATTEMPT_UNSETTLED',
      'revision while attempt unsettled refused (M)');
  });

  // Q: revision serializes behind the admission transaction's locked Ticket.
  {
    const t3 = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Serialization target', createdBy: 'dana' },
      eventPayload: {}
    });
    const client = await storeA.pool.connect();
    await client.query('BEGIN');
    try {
      // The admission completes its WORK but keeps the Ticket row locked
      // until this transaction ends — exactly the serialization window a
      // concurrent revision must respect.
      const admissionPromise = storeA.createRunsAndStartTicket({
        ticketId: t3.ticket.id,
        runDrafts: [{ ticketId: t3.ticket.id, agentId: AGENT_ID + 9, executionMode: 'agent' }]
      }, { client });
      await admissionPromise;
      const revisionDuringAdmission = storeA.reviseTicketObjective({
        ticketId: t3.ticket.id, expectedRevision: t3.ticket.revision + 1,
        objective: 'during-admission change', acceptanceCriteria: null,
        reasonCode: 'correction', reason: 'serialized behind admission lock', actor: 'bob'
      }).then(() => 'committed').catch(error =>
        error.code || 'unknown-refusal');
      let settled = false;
      void revisionDuringAdmission.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 200));
      ok(settled === false,
        'revision blocks behind the admission transaction\'s Ticket lock (Q)');
      await client.query('COMMIT');
      const outcome = await revisionDuringAdmission;
      ok(outcome === 'TICKET_ATTEMPT_UNSETTLED',
        'revision serialized after admission and then refuses unsettled attempt (Q/M)');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  // T/U: projection drift fails admission closed.
  async function expectIntegrityRefusal(ticketId) {
    try {
      await storeA.createRunsAndStartTicket({
        ticketId, runDrafts: [{
          ticketId, agentId: AGENT_ID + 20, executionMode: 'agent'
        }]
      });
      return null;
    } catch (error) {
      return error.code || error.message;
    }
  }
  {
    const tamper = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Tamper target pointer', createdBy: 'eve' },
      eventPayload: {}
    });
    await settleAttemptAndReopenForTamper(storeA, tamper.ticket.id);
    await pool.query(
      `UPDATE "${schemaA}".tickets
          SET body = jsonb_set(body, '{objectiveRevision}',
                               '{"number":9,"hash":"${'e'.repeat(64)}"}'::jsonb),
              revision = revision + 1
        WHERE id = $1`, [tamper.ticket.id]);
    const outcome = await expectIntegrityRefusal(tamper.ticket.id);
    ok(outcome === 'TICKET_OBJECTIVE_REVISION_INTEGRITY',
      'pointer/head drift fails admission closed (T)');
  }
  {
    const tamper2 = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Tamper target content', createdBy: 'eve' },
      eventPayload: {}
    });
    await settleAttemptAndReopenForTamper(storeA, tamper2.ticket.id);
    await pool.query(
      `UPDATE "${schemaA}".tickets
          SET body = jsonb_set(body, '{objective}', '"smuggled drift"'::jsonb),
              revision = revision + 1
        WHERE id = $1`, [tamper2.ticket.id]);
    const outcome = await expectIntegrityRefusal(tamper2.ticket.id);
    ok(outcome === 'TICKET_OBJECTIVE_REVISION_INTEGRITY',
      'projected content vs chain-head drift fails admission closed (U)');
  }
  async function settleAttemptAndReopenForTamper(store, ticketId) {
    await settleAttemptAndReopen(pool, schemaA, store, ticketId);
  }

  // V: old evidence/stamps remain authoritative across a later revision.
  {
    const oldStamp = admission.runs[0].objectiveRevision;
    await settleAttemptAndReopen(pool, schemaA, storeA, t2.ticket.id);
    const currentRevision = Number((await pool.query(
      `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`, [t2.ticket.id])).rows[0].revision);
    const revisedV = await storeA.reviseTicketObjective({
      ticketId: t2.ticket.id, expectedRevision: currentRevision,
      objective: 'Admission target v2', acceptanceCriteria: 'verified',
      reasonCode: 'scope_note', reason: 'success criteria tightened', actor: 'bob'
    });
    ok(revisedV.objectiveRevision.number === oldStamp.number + 1,
      'post-settlement revision proceeds to N+1 (V setup)');
    const secondAdmission = await storeA.createRunsAndStartTicket({
      ticketId: t2.ticket.id,
      runDrafts: [{ ticketId: t2.ticket.id, agentId: AGENT_ID + 30, executionMode: 'agent' }]
    });
    ok(secondAdmission.runs[0].objectiveRevision.hash === revisedV.objectiveRevision.hash &&
       secondAdmission.runs[0].objectiveRevision.number === 2,
      'new attempt binds the NEW revision (V)');
    const firstRuns = await pool.query(
      `SELECT body->'objectiveRevision' AS s, body->'declaredWorkSnapshot' AS dw,
              body->'completionAuthoritySnapshot' AS ca
         FROM "${schemaA}".runs WHERE ticket_attempt_id = $1 ORDER BY id`,
      [admission.attempt.id]);
    ok(firstRuns.rows.every(row =>
      row.s.number === oldStamp.number && row.s.hash === oldStamp.hash),
      'old Runs keep their original revision stamps (V)');
    ok(firstRuns.rows.every(row => row.dw === null && row.ca === null),
      'old Run snapshot fields untouched by revision (V)');
  }

  // N: blockers preserved verbatim through revision.
  {
    const blocked = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Blocked revision target', createdBy: 'alice' },
      eventPayload: {}
    });
    const triageDoc = {
      required: true, resolvedAt: null, reasonCode: 'authority_blocked',
      summary: 'fixture blocker', requiredDecision: 'change_scope'
    };
    await pool.query(
      `UPDATE "${schemaA}".tickets
          SET status = 'blocked',
              body = jsonb_set(body, '{triage}', $2::jsonb),
              revision = revision + 1
        WHERE id = $1`, [blocked.ticket.id, JSON.stringify(triageDoc)]);
    const beforeRow = (await pool.query(
      `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`, [blocked.ticket.id])).rows[0];
    const revisedBlocked = await storeA.reviseTicketObjective({
      ticketId: blocked.ticket.id, expectedRevision: Number(beforeRow.revision),
      objective: 'Blocked revision target v2', acceptanceCriteria: null,
      reasonCode: 'clarification', reason: 'clarify under active blocker', actor: 'bob'
    });
    ok(revisedBlocked.ticket.status === 'blocked', 'blocker class: status preserved (N)');
    ok(require('../runtime/declared-work-contract').hashCanonical(revisedBlocked.ticket.triage) ===
       require('../runtime/declared-work-contract').hashCanonical(triageDoc),
      'unresolved triage document preserved verbatim through revision (N)');
  }

  // O: attempts consumed under earlier revisions still count (Ticket-wide),
  // and an exhausted Ticket stays exhausted across a revision until the
  // EXISTING explicit maxAttempts authority raises the limit.
  {
    const exhausted = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Exhaustion target', createdBy: 'alice' },
      eventPayload: {}
    });
    const budgetOne = minimalBudgetSnapshot(1);
    const firstAdmission = await storeA.createRunsAndStartTicket({
      ticketId: exhausted.ticket.id,
      runDrafts: [{
        ticketId: exhausted.ticket.id, agentId: AGENT_ID + 50,
        executionMode: 'agent', runtimeBudgetSnapshot: budgetOne
      }]
    });
    ok(firstAdmission.attempt.ordinal === 1, 'exhaustion fixture admitted attempt 1');
    await settleAttemptAndReopen(pool, schemaA, storeA, exhausted.ticket.id);
    const attemptsBeforeRevision = Number((await pool.query(
      `SELECT count(*)::int AS n FROM "${schemaA}".ticket_attempts WHERE ticket_id = $1`,
      [exhausted.ticket.id])).rows[0].n);
    const currentRev = Number((await pool.query(
      `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`, [exhausted.ticket.id])).rows[0].revision);
    const revisedExhausted = await storeA.reviseTicketObjective({
      ticketId: exhausted.ticket.id, expectedRevision: currentRev,
      objective: 'Exhaustion target v2', acceptanceCriteria: null,
      reasonCode: 'correction', reason: 'same ticket, corrected outcome', actor: 'bob'
    });
    ok(revisedExhausted.objectiveRevision.number === 2,
      'revision proceeds on an exhausted Ticket (attempts are NOT reset)');
    const attemptsAfterRevision = Number((await pool.query(
      `SELECT count(*)::int AS n FROM "${schemaA}".ticket_attempts WHERE ticket_id = $1`,
      [exhausted.ticket.id])).rows[0].n);
    ok(attemptsAfterRevision === attemptsBeforeRevision,
      'objective revision consumes/deletes no attempts (O)');
    const stillExhausted = await storeA.createRunsAndStartTicket({
      ticketId: exhausted.ticket.id,
      runDrafts: [{
        ticketId: exhausted.ticket.id, agentId: AGENT_ID + 51,
        executionMode: 'agent', runtimeBudgetSnapshot: budgetOne
      }]
    }).then(() => null).catch(error => error.code || error.message);
    ok(stillExhausted === 'RUN_BUDGET_EXHAUSTED',
      'post-revision admission still refuses: budget counts pre-revision attempts (O)');
    // Existing explicit T2 authority releases the exhaustion.
    await storeA.updateTicketMaxAttempts({
      ticketId: exhausted.ticket.id,
      expectedRevision: revisedExhausted.ticket.revision,
      expectedExecutionPolicy: null,
      maxAttempts: 3,
      changedBy: 'bob'
    });
    const released = await storeA.createRunsAndStartTicket({
      ticketId: exhausted.ticket.id,
      runDrafts: [{
        ticketId: exhausted.ticket.id, agentId: AGENT_ID + 52,
        executionMode: 'agent', runtimeBudgetSnapshot:
          minimalBudgetSnapshot(3)
      }]
    });
    ok(released.attempt.ordinal === 2, 'explicit maxAttempts raise releases admission (O)');
    void stillExhausted;
  }

  // P: concurrent revisions serialize; exactly one wins per expectedRevision.
  {
    const pTarget = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Concurrency target', createdBy: 'alice' },
      eventPayload: {}
    });
    const attemptOne = storeA.reviseTicketObjective({
      ticketId: pTarget.ticket.id, expectedRevision: pTarget.ticket.revision,
      objective: 'Concurrent A', acceptanceCriteria: null,
      reasonCode: 'correction', reason: 'writer A', actor: 'alice'
    });
    const attemptTwo = storeA.reviseTicketObjective({
      ticketId: pTarget.ticket.id, expectedRevision: pTarget.ticket.revision,
      objective: 'Concurrent B', acceptanceCriteria: null,
      reasonCode: 'correction', reason: 'writer B', actor: 'bob'
    });
    const outcomes = await Promise.allSettled([attemptOne, attemptTwo]);
    const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
    const rejected = outcomes.filter(o => o.status === 'rejected');
    ok(fulfilled.length === 1 && rejected.length === 1,
      'concurrent revisions serialize: exactly one commits (P)');
    const finalPtr = await pointer(pool, schemaA, pTarget.ticket.id);
    ok(finalPtr.number === 2, 'loser left no partial state; chain advanced once (P)');
  }

  // GENERIC MUTATION BYPASS SEALED: generic transitionTicket must refuse any
  // requested-outcome keys, leaving revision authority exclusively to
  // reviseTicketObjective.
  {
    const bypass = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Bypass seal target', createdBy: 'alice' },
      eventPayload: {}
    });
    const tid = bypass.ticket.id;
    const currentRev = Number((await pool.query(
      `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`, [tid])).rows[0].revision);
    const stateBefore = {
      pointer: await pointer(pool, schemaA, tid),
      head: await headEvent(pool, schemaA, tid),
      events: await revisionEventsCount(pool, schemaA, tid),
      row: (await pool.query(
        `SELECT body, revision FROM "${schemaA}".tickets WHERE id = $1`, [tid])).rows[0]
    };
    for (const [key, value] of [
      ['objective', 'smuggled objective'],
      ['acceptanceCriteria', 'smuggled criteria']
    ]) {
      await storeA.transitionTicket({
        ticketId: tid,
        expectedRevision: currentRev,
        fromStatuses: ['open'],
        toStatus: 'open',
        patch: { [key]: value }
      }).then(() => ok(false, `${key} patch must refuse`)).catch(error => {
        ok(error.code === 'TICKET_OBJECTIVE_REVISION_REQUIRED',
          `generic ${key} mutation refused with TICKET_OBJECTIVE_REVISION_REQUIRED`);
      });
    }
    const stateAfter = {
      pointer: await pointer(pool, schemaA, tid),
      head: await headEvent(pool, schemaA, tid),
      events: await revisionEventsCount(pool, schemaA, tid),
      row: (await pool.query(
        `SELECT body, revision FROM "${schemaA}".tickets WHERE id = $1`, [tid])).rows[0]
    };
    ok(JSON.stringify(stateBefore) === JSON.stringify(stateAfter),
      'refused patches leave body, pointer, chain and generic revision untouched');

    // Unrelated generic fields still transition normally.
    await storeA.transitionTicket({
      ticketId: tid,
      expectedRevision: stateAfter.row.revision,
      fromStatuses: ['open'],
      toStatus: 'open',
      patch: { priority: 'high' }
    });
    const afterUnrelated = (await pool.query(
      `SELECT body->>'priority' AS p, revision FROM "${schemaA}".tickets WHERE id = $1`,
      [tid])).rows[0];
    ok(afterUnrelated.p === 'high' &&
       Number(afterUnrelated.revision) === Number(stateAfter.row.revision) + 1,
      'unrelated transitionTicket fields still mutate normally');
  }

  // STRUCTURED REQUESTED-OUTCOME SEAL: Tickets carrying
  // structuredAllocationAuthority are not revisable through T3 v1, and
  // generic transitionTicket may not change EITHER identity component.
  {
    const {
      buildStructuredAllocationAuthorityDraft,
      canonicalObjective: prerequisitesCanonicalObjective
    } = require('../runtime/structured-allocation-prerequisites-contract');
    const structuredGroup = (await storeA.createGroup({
      value: { name: `T3 structured group ${stamp}`, permissions: [], canReceiveTickets: true },
      changedBy: 't3-structured-seal'
    })).group;
    const structuredPlanner = (await storeA.createConfiguredAgent({
      value: { name: `T3 planner ${stamp}`, provider: 'openai', model: 'gpt-x', apiKey: '' },
      groupIds: [structuredGroup.id],
      changedBy: 't3-structured-seal'
    })).agent;
    const structuredWorker = (await storeA.createConfiguredAgent({
      value: { name: `T3 worker ${stamp}`, provider: 'openai', model: 'gpt-x', apiKey: '' },
      groupIds: [structuredGroup.id],
      changedBy: 't3-structured-seal'
    })).agent;
    const designatedGroup = (await storeA.updateGroup({
      groupId: structuredGroup.id,
      expectedRevision: structuredGroup.revision,
      value: { ...structuredGroup, plannerAgentId: structuredPlanner.id },
      changedBy: 't3-structured-seal'
    })).group;
    const structuredObjective = `Structured seal objective ${stamp}`;
    const authorityDraft = buildStructuredAllocationAuthorityDraft({
      declaredWork: {
        objective: structuredObjective,
        expectedOutputs: [{ kind: 'text', declaration: 'One sealed report' }],
        successCriteria: [{ kind: 'text', declaration: 'Sealed report is inspectable' }],
        evidenceRequirements: []
      },
      ticketObjective: structuredObjective,
      assignmentTargetType: 'group',
      assignmentMode: 'allocated',
      assignmentGroup: designatedGroup,
      plannerAgent: structuredPlanner,
      candidateAgents: [structuredWorker, structuredPlanner],
      ownedOutputPaths: { [structuredWorker.id]: 'sealed/worker/', [structuredPlanner.id]: 'sealed/planner/' }
    });
    const structured = await storeA.createTicketWithEvent({
      ticket: {
        status: 'blocked',
        blockedReason: 'T3 structured seal fixture; no worker run is admitted.',
        objective: structuredObjective,
        acceptanceCriteria: 'Original sealed criteria.',
        assignmentTargetType: 'group',
        assignmentTargetId: designatedGroup.id,
        assignmentMode: 'allocated',
        ownedOutputPaths: {
          [structuredWorker.id]: 'sealed/worker/',
          [structuredPlanner.id]: 'sealed/planner/'
        }
      },
      structuredAllocationAuthorityDraft: authorityDraft,
      eventPayload: { source: 't3-structured-seal' }
    }).then(result => result.ticket);
    ok(structured.structuredAllocationAuthority &&
       structured.structuredAllocationAuthority.authorityHash,
      'structured fixture materializes its authority');
    const structuredRow = async () => (await pool.query(
      `SELECT body, revision FROM "${schemaA}".tickets WHERE id = $1`, [structured.id])).rows[0];
    const stateBefore = JSON.stringify(await structuredRow());
    const headBeforeCount = await revisionEventsCount(pool, schemaA, structured.id);

    // A. objective materially changed -> verbatim historical refusal.
    await storeA.transitionTicket({
      ticketId: structured.id,
      expectedRevision: Number((await structuredRow()).revision),
      fromStatuses: ['blocked'], toStatus: 'blocked',
      patch: { objective: `${structuredObjective} CHANGED` }
    }).then(() => ok(false, 'structured objective change must refuse')).catch(error => {
      ok(error.code === 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE' &&
         /objective cannot change after structured-allocation authority admission/.test(error.message),
        'structured objective change refuses verbatim historical code/message (A)');
    });

    // B. acceptanceCriteria materially changed -> same immutability authority.
    await storeA.transitionTicket({
      ticketId: structured.id,
      expectedRevision: Number((await structuredRow()).revision),
      fromStatuses: ['blocked'], toStatus: 'blocked',
      patch: { acceptanceCriteria: 'CHANGED sealed criteria.' }
    }).then(() => ok(false, 'structured criteria change must refuse')).catch(error => {
      ok(error.code === 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE' &&
         /acceptanceCriteria cannot change after structured-allocation authority admission/.test(error.message),
        'structured acceptanceCriteria-only change refuses under the same authority (B)');
    });

    // C. both fields materially changed -> deterministic single refusal.
    await storeA.transitionTicket({
      ticketId: structured.id,
      expectedRevision: Number((await structuredRow()).revision),
      fromStatuses: ['blocked'], toStatus: 'blocked',
      patch: {
        objective: `${structuredObjective} BOTH`,
        acceptanceCriteria: 'BOTH changed criteria.'
      }
    }).then(() => ok(false, 'both-field change must refuse')).catch(error => {
      ok(error.code === 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE',
        'both-field structured change refuses deterministically with the objective-code precedence (C)');
    });

    const stateAfter = JSON.stringify(await structuredRow());
    ok(stateBefore === stateAfter,
      'refusals leave structured body and generic revision byte-unchanged (D/G)');
    ok(await pointer(pool, schemaA, structured.id) !== null &&
       (await headEvent(pool, schemaA, structured.id)).payload.number === 1,
      'pointer and chain unchanged after structured refusals (E/F)');
    ok(await revisionEventsCount(pool, schemaA, structured.id) === headBeforeCount,
      'no new revision events after structured refusals');

    // Equal-value requested-outcome keys pass through the ordinary transition
    // (historical mechanics: generic revision advances, bytes do not drift).
    await storeA.transitionTicket({
      ticketId: structured.id,
      expectedRevision: Number((await structuredRow()).revision),
      fromStatuses: ['blocked'], toStatus: 'blocked',
      patch: {
        objective: structuredObjective,
        acceptanceCriteria: 'Original sealed criteria.'
      }
    });
    // Canonical-equal requested-outcome keys carry no storage authority:
    // every allowed case below must leave objective/criteria BYTES exactly
    // as persisted, regardless of padding, while the ordinary transition
    // still advances generic revision. (MEDIUM-1/LOW-2 seal.)
    async function expectCanonicalEqualPassThrough(patch, label) {
      const revBefore = Number((await structuredRow()).revision);
      await storeA.transitionTicket({
        ticketId: structured.id,
        expectedRevision: revBefore,
        fromStatuses: ['blocked'], toStatus: 'blocked',
        patch
      });
      const rowAfter = await structuredRow();
      ok(rowAfter.body.objective === structuredObjective &&
         rowAfter.body.acceptanceCriteria === 'Original sealed criteria.',
         `${label}: stored requested-outcome bytes unchanged`);
      ok(Number(rowAfter.revision) === revBefore + 1,
         `${label}: generic revision follows ordinary transition semantics`);
      ok(await pointer(pool, schemaA, structured.id) !== null &&
         (await headEvent(pool, schemaA, structured.id)).payload.number === 1 &&
         (await revisionEventsCount(pool, schemaA, structured.id)) === 1,
         `${label}: pointer and revision-event chain unchanged`);
    }

    // A. exact-byte equal objective.
    await expectCanonicalEqualPassThrough(
      { objective: structuredObjective }, 'exact-byte equal objective');
    // B. whitespace-padded canonically-equal objective (LOW-2 accidental
    //    STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT path eliminated).
    await expectCanonicalEqualPassThrough(
      { objective: `  ${structuredObjective}  ` }, 'padded equal objective');
    // C. exact-byte equal acceptanceCriteria.
    await expectCanonicalEqualPassThrough(
      { acceptanceCriteria: 'Original sealed criteria.' },
      'exact-byte equal acceptanceCriteria');
    // D. whitespace-padded canonically-equal acceptanceCriteria.
    await expectCanonicalEqualPassThrough(
      { acceptanceCriteria: '  Original sealed criteria.  ' },
      'padded equal acceptanceCriteria');
    // E. both fields canonically equal but byte-different.
    await expectCanonicalEqualPassThrough({
      objective: ` ${structuredObjective} `,
      acceptanceCriteria: '\nOriginal sealed criteria.\n'
    }, 'both fields canonical-equal byte-different');
    // F. requested-outcome keys plus an unrelated legitimate patch field.
    {
      const revBefore = Number((await structuredRow()).revision);
      const unrelatedFieldPatch = {
        objective: `  ${structuredObjective}  `,
        acceptanceCriteria: '  Original sealed criteria.  ',
        blockedReason: 'T3 structured seal fixture; unrelated field co-mutation.'
      };
      const unrelatedResult = await storeA.transitionTicket({
        ticketId: structured.id,
        expectedRevision: revBefore,
        fromStatuses: ['blocked'], toStatus: 'blocked',
        patch: unrelatedFieldPatch
      });
      const rowAfter = await structuredRow();
      ok(unrelatedResult.ticket.blockedReason === stopLikeBlockedReason(unrelatedFieldPatch) &&
         rowAfter.body.blockedReason === unrelatedFieldPatch.blockedReason,
         'F: unrelated legitimate field changes where supplied');
      ok(rowAfter.body.objective === structuredObjective &&
         rowAfter.body.acceptanceCriteria === 'Original sealed criteria.',
         'F: requested-outcome bytes unchanged alongside unrelated field');
      ok(Number(rowAfter.revision) === revBefore + 1,
         'F: generic revision follows ordinary transition semantics');
    }
    function stopLikeBlockedReason(patch) { return patch.blockedReason; }

    void prerequisitesCanonicalObjective;
  }

  // HIGH-2 regression: revision follows the frozen attempt -> Ticket lock
  // order, so a settlement-direction writer holding the attempt lock can
  // never form a Ticket->attempt cycle with it. Deterministic structural
  // proof: TxnA locks attempt authority first; only then the real revision
  // starts on pinned TxnB; an independent observer uses pg_stat_activity and
  // pg_blocking_pids(PID_B) to prove PID_B is blocked by PID_A on the
  // attempt-authority query; TxnA can still acquire Ticket while B waits,
  // falsifying any Ticket->attempt order; TxnA commits and the revision
  // serializes coherently.
  {
    const deadlockTarget = await storeA.createTicketWithEvent({
      ticket: { status: 'open', objective: 'Deadlock regression target', createdBy: 'alice' },
      eventPayload: {}
    });
    const seededAdmission = await storeA.createRunsAndStartTicket({
      ticketId: deadlockTarget.ticket.id,
      runDrafts: [{ ticketId: deadlockTarget.ticket.id, agentId: AGENT_ID + 60, executionMode: 'agent' }]
    });
    const attemptId = seededAdmission.attempt.id;

    // Deterministic HIGH-2 structural proof, mirroring the proven standalone
    // diagnostic topology: pinned TxnA acquires the latest attempt authority
    // FIRST; only then does the REAL reviseTicketObjective start on pinned
    // TxnB; an independent observer connection positively identifies that
    // PID_B is blocked BY PID_A on the attempt-authority query; TxnA then
    // proves it can still acquire the Ticket row (falsifying any
    // Ticket->attempt revision order) before committing and letting the
    // revision serialize to its frozen refusal.
    const txnA = await storeA.pool.connect();
    const txnB = await storeA.pool.connect();
    const observer = new Pool({ connectionString: databaseUrl });
    const pidA = Number((await txnA.query('SELECT pg_backend_pid() AS p')).rows[0].p);
    const pidB = Number((await txnB.query('SELECT pg_backend_pid() AS p')).rows[0].p);
    ok(Number.isSafeInteger(pidA) && Number.isSafeInteger(pidB) && pidA !== pidB,
      'HIGH-2: distinct pinned backends for writer and revision');

    const isAttemptAuthorityQuery = text =>
      /ticket_attempts/i.test(text) &&
      /ORDER\s+BY\s+ordinal\s+DESC/i.test(text) &&
      /FOR\s+UPDATE/i.test(text);

    await txnA.query('BEGIN');
    // Frozen settlement-direction writer: attempt authority FIRST.
    const attemptLock = await txnA.query(
      `SELECT disposition FROM "${schemaA}".ticket_attempts WHERE id = $1 FOR UPDATE`,
      [attemptId]);
    ok(attemptLock.rowCount === 1, 'HIGH-2: writer holds the latest attempt authority');

    // ONLY NOW start the real revision on pinned TxnB. No scheduling race:
    // TxnA already owns the authority the revision must wait behind.
    let revisionSettled = false;
    let revisionOutcome = null;
    const revisionPromise = storeA.reviseTicketObjective({
      ticketId: deadlockTarget.ticket.id,
      expectedRevision: Number((await pool.query(
        `SELECT revision FROM "${schemaA}".tickets WHERE id = $1`,
        [deadlockTarget.ticket.id])).rows[0].revision),
      objective: 'post-lock-order change', acceptanceCriteria: null,
      reasonCode: 'correction', reason: 'must serialize behind attempt authority', actor: 'bob'
    }, { client: txnB }).then(() => {
      revisionSettled = true;
      return 'committed';
    }, error => {
      revisionSettled = true;
      revisionOutcome = { code: error.code, message: error.message || String(error) };
      return revisionOutcome;
    });

    // Observer: bounded containment for STATE 1 (not arrived yet). Success
    // requires STATE 2 — active/Lock on the attempt-authority query with
    // pg_blocking_pids(PID_B) naming PID_A.
    let blockedByWriter = false;
    for (let i = 0; i < 400 && !blockedByWriter && !revisionSettled; i += 1) {
      const probe = await observer.query(
        `SELECT state, wait_event_type, query
           FROM pg_stat_activity WHERE pid = $1::int`, [pidB]);
      const activity = probe.rowCount === 0 ? null : probe.rows[0];
      if (activity &&
          activity.state === 'active' &&
          activity.wait_event_type === 'Lock' &&
          isAttemptAuthorityQuery(activity.query)) {
        const blockers = await observer.query(
          `SELECT pg_blocking_pids($1::int) AS blockers`, [pidB]);
        if ((blockers.rows[0].blockers || []).map(Number).includes(pidA)) {
          blockedByWriter = true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    ok(blockedByWriter,
      'revision blocks on attempt authority while writer holds it (HIGH-2)');
    ok(!revisionSettled,
      'HIGH-2: revision did not settle before blocking on attempt authority');

    // Structural second half: while PID_B remains blocked by PID_A on the
    // attempt, the settlement-direction writer MUST still be able to acquire
    // the Ticket row. If the revision held Ticket first, this statement would
    // block; statement_timeout turns that into a contained failure instead of
    // a deadlock abort.
    await txnA.query('SET LOCAL statement_timeout = 5000');
    const ticketAcquiredByWriter = await txnA.query(
      `SELECT id FROM "${schemaA}".tickets WHERE id = $1 FOR UPDATE`,
      [deadlockTarget.ticket.id]);
    ok(ticketAcquiredByWriter.rowCount === 1,
      'HIGH-2: writer acquires Ticket while revision remains blocked on attempt authority — falsifies Ticket->attempt order');

    // Complete the serialization: release attempt+Ticket authority; frozen
    // semantics then resolve the blocked revision coherently.
    await txnA.query('COMMIT');
    await revisionPromise;
    await txnA.release();
    await txnB.release();
    await observer.end();

    const outcomeText = typeof revisionOutcome === 'object'
      ? `${revisionOutcome.code} ${revisionOutcome.message}`
      : String(revisionOutcome);
    ok(!/40P01|deadlock/i.test(outcomeText),
      `no PostgreSQL 40P01/deadlock after lock-order correction (HIGH-2): ${outcomeText}`);
    ok(revisionOutcome === 'TICKET_ATTEMPT_UNSETTLED' ||
       (typeof revisionOutcome === 'object' &&
        revisionOutcome.code === 'TICKET_ATTEMPT_UNSETTLED'),
      'serialized revision refuses the unsettled attempt coherently (HIGH-2)');
    const postHead = await headEvent(pool, schemaA, deadlockTarget.ticket.id);
    ok(postHead.payload.number === 1 && !postHead.payload.contentHash.startsWith('f'.repeat(8)),
      'no partial revision event/projection mutation survived the blocked attempt');
    void deadlockTarget;
  }

  // ── Refusal schemas: F/I/J and Y ─────────────────────────────────────────
  console.log('activation refusal boundaries');
  {
    const schemaB = `t3a_${stamp}_b`;
    await createSchemaThrough(pool, schemaB, 40);
    await seedLegacyTicket(pool, schemaB, { objective: 'Good legacy ticket' });
    const stray = await seedLegacyTicket(pool, schemaB, { objective: 'Stray history ticket' });
    await pool.query(
      `INSERT INTO "${schemaB}".events
         (id, schema_version, ts, type, ticket_id, payload)
       VALUES (md5(random()::text)::uuid, 1, clock_timestamp(), $1, $2,
               $3::jsonb)`,
      [REV_EVENT, stray.id, JSON.stringify({
        number: 1, provenance: 'revision', content: { objective: 'x', acceptanceCriteria: null },
        contentHash: revisionContentHash(canonicalRevisionContent({
          objective: 'x', acceptanceCriteria: null })),
        previous: null, actor: 'ghost', reasonCode: 'creation',
        reason: null, capturedAt: new Date().toISOString()
      })]);
    const storeB = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaB, disposableMigrations: true });
    try {
      await storeB.migrate().then(() => ok(false, 'stray history must refuse baseline'))
        .catch(error => {
          ok(String(error.message).includes('already carries'),
            'unexpected prior revision state refuses baseline (I)');
        });
      const goodLeft = await pool.query(
        `SELECT body->'objectiveRevision' AS p FROM "${schemaB}".tickets
          WHERE body->>'objective' = 'Good legacy ticket'`);
      ok(goodLeft.rows[0].p === null,
        'refusal leaves zero partial baselines across ALL Tickets (J/G)');
    } finally {
      await storeB.close();
    }
  }
  {
    const schemaC = `t3a_${stamp}_c`;
    await createSchemaThrough(pool, schemaC, 40);
    await seedLegacyTicket(pool, schemaC, { objective: '   padded   ' });
    const storeC = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaC, disposableMigrations: true });
    try {
      await storeC.migrate().then(() => ok(false, 'noncanonical legacy must refuse'))
        .catch(error => {
          ok(String(error.message).includes('canonically trimmed'),
            'malformed/direct-DB noncanonical content refuses without repair (F)');
        });
    } finally {
      await storeC.close();
    }
  }
  {
    // Y: un-revisioned (raw pre-T3) Tickets cannot admit until baselined.
    const schemaD = `t3a_${stamp}_d`;
    await createSchemaThrough(pool, schemaD, 40);
    await applyMigration041Manually(pool, schemaD);
    const rawTicket = await seedLegacyTicket(pool, schemaD, { objective: 'Raw pre-T3 ticket' });
    const storeD = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaD, disposableMigrations: true });
    try {
      const earlyRefusal = await storeD.createRunsAndStartTicket({
        ticketId: rawTicket.id,
        runDrafts: [{ ticketId: rawTicket.id, agentId: AGENT_ID + 40, executionMode: 'agent' }]
      }).then(() => null).catch(error => error.code || error.message);
      ok(earlyRefusal === 'TICKET_OBJECTIVE_REVISION_INTEGRITY',
        'pointerless pre-activation Ticket cannot become executed intent (Y)');
      await storeD.migrate(); // activation baseline now covers the raw Ticket
      const admitted = await storeD.createRunsAndStartTicket({
        ticketId: rawTicket.id,
        runDrafts: [{ ticketId: rawTicket.id, agentId: AGENT_ID + 41, executionMode: 'agent' }]
      });
      ok(admitted.runs[0].objectiveRevision.number === 1,
        'post-baseline admission binds baseline revision 1 (Y/X)');
    } finally {
      await storeD.close();
    }
  }

  // HIGH-1: objective-less legacy Tickets are an ACTIVATION PRECONDITION
  // failure — 042 refuses the whole transaction before any mutation.
  {
    const schemaE = `t3a_${stamp}_e`;
    await createSchemaThrough(pool, schemaE, 40);
    const good = await seedLegacyTicket(pool, schemaE, { objective: 'Canonical legacy ticket' });
    await seedLegacyTicket(pool, schemaE, { objective: null }); // objective-less legacy row
    const beforeRows = (await pool.query(
      `SELECT id, status, body, revision FROM "${schemaE}".tickets ORDER BY id`)).rows;
    const ledgerBefore = (await pool.query(
      `SELECT version FROM "${schemaE}".schema_migrations ORDER BY version`)).rows;

    const storeE = new PostgresRuntimeStore({ connectionString: databaseUrl, schema: schemaE, disposableMigrations: true });
    try {
      let refusalCode = null;
      let refusalMessage = '';
      try {
        await storeE.migrate();
      } catch (error) {
        refusalCode = error.code;
        refusalMessage = error.message || String(error);
      }
      ok(refusalCode === 'T042_OBJECTIVE_REVISION_BASELINE_REQUIRED',
        `objective-less legacy Ticket raises the named precondition refusal (got ${refusalCode})`);
      ok(/objective absent/.test(refusalMessage),
        'refusal identifies reason class: requested-outcome objective absent');
      ok(!/pointer must be an object/.test(refusalMessage),
        'no raw pointer TypeError surfaces for this known legacy class');

      const ledger042 = Number((await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaE}".schema_migrations
          WHERE version LIKE '042%'`)).rows[0].n);
      ok(ledger042 === 0, '042 ledger count remains 0 after precondition refusal');
      const baselineEvents = Number((await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaE}".events
          WHERE type = 'ticket.objective_revised'`)).rows[0].n);
      ok(baselineEvents === 0, 'zero T3 baseline events survive');
      const pointers = Number((await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaE}".tickets
          WHERE body->'objectiveRevision' IS NOT NULL`)).rows[0].n);
      ok(pointers === 0, 'zero objectiveRevision pointers survive');
      const guardEnabled = Number((await pool.query(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = 'tickets_revision_guard'
            AND tgrelid = '"${schemaE}".tickets'::regclass AND tgenabled <> 'O'`)).rows[0].n);
      ok(guardEnabled === 0, 'tickets_revision_guard enabled after rollback');
      const afterRows = (await pool.query(
        `SELECT id, status, body, revision FROM "${schemaE}".tickets ORDER BY id`)).rows;
      ok(JSON.stringify(afterRows) === JSON.stringify(beforeRows),
        'all Ticket rows/body/revisions byte-unchanged; valid sibling Ticket unaffected');

      void good;
    } finally {
      await storeE.close();
    }
  }

  // Completion/evidence compatibility note (§17): stamped hashes tie Runs to
  // the exact canonical requested-outcome content admitted; existing
  // completion contracts are untouched owners of their own identities.
  ok(typeof IDENTITY_REGISTER.COMPLETION_OBJECTIVE_HASH.binds === 'string',
    'identity register documents completion-objectiveHash separation');

  await storeA.close();
  for (const suffix of ['a', 'b', 'c', 'd']) {
    await pool.query(`DROP SCHEMA IF EXISTS "t3a_${stamp}_${suffix}" CASCADE`).catch(() => {});
  }
  await pool.end();
  console.log(`\nPASS: T3 objective-revision kernel — ${assertions} assertions (PostgreSQL-native)`);
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
