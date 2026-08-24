#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withHarness } = require('./postgres-test-harness');

const ACTOR = 't2-five-state-classifier-postgres-test';
const CLOSE_AT = new Date().toISOString();

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    console.error('TEST_DATABASE_URL is required for the PostgreSQL classifier test');
    process.exit(1);
  }
  // T2 Tranche 5: legacy closed traces can no longer be produced against the
  // five-state schema (tickets_status_check refuses 'closed' by design), so
  // this suite bootstraps its own SIX-STATE legacy schema (migrations
  // 001..040) and classifies there — the same substrate migration 041 faces.
  const { Pool } = require('pg');
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');
  const MIGRATIONS_DIR = path.join(__dirname, '..', 'persistence', 'postgres', 'migrations');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const legacySchema = `t041legacy_${Date.now().toString(36)}`;
  const bootstrap = await pool.connect();
  await bootstrap.query(`CREATE SCHEMA "${legacySchema}"`);
  await bootstrap.query(
    `CREATE TABLE "${legacySchema}".schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
  for (const file of fs.readdirSync(MIGRATIONS_DIR)
    .filter(n => /^\d{3}_.*\.sql$/.test(n))
    .filter(n => Number(n.slice(0, 3)) <= 40).sort()) {
    await bootstrap.query('BEGIN');
    await bootstrap.query(`SET LOCAL search_path TO "${legacySchema}", public`);
    await bootstrap.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    await bootstrap.query(
      `INSERT INTO "${legacySchema}".schema_migrations (version) VALUES ($1)`, [file]);
    await bootstrap.query('COMMIT');
  }
  bootstrap.release();
  const store = new PostgresRuntimeStore({
    connectionString: process.env.TEST_DATABASE_URL, schema: legacySchema
  });
  await withHarness('t2 five-state classifier', async ({ databaseUrl }) => {
    let assertions = 0;
    const check = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };
    const agent = (await store.createConfiguredAgent({
      value: { name: `Classifier Agent ${Date.now()}`, provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const peer = (await store.createConfiguredAgent({
      value: { name: `Classifier Peer ${Date.now()}`, provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const makeTicket = (objective, status = 'open', extra = {}) => store.createTicket({
      objective,
      status,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      executionMode: 'agent',
      ...extra
    });
    const draft = (ticketId, agentId = agent.id) => ({
      ticketId,
      agentId,
      status: 'pending',
      executionMode: 'agent'
    });
    const admit = (ticket, drafts = [draft(ticket.id)]) =>
      store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: drafts,
        runEventPayload: () => ({ source: ACTOR })
      });
    const terminalize = async run => {
      const owner = `${ACTOR}-${run.id}`;
      const claim = await store.claimPendingRun({
        leaseOwner: owner,
        leaseDurationMs: 60_000,
        eligibleRunIds: [run.id]
      });
      assert.ok(claim && claim.run);
      const started = await store.startClaimedRun({
        runId: run.id,
        leaseOwner: owner,
        leaseDurationMs: 60_000
      });
      return store.transitionRun({
        runId: run.id,
        expectedRevision: started.run.revision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: owner,
        eventType: 'run.completed',
        eventPayload: { source: ACTOR }
      });
    };
    // T2 Tranche 5: the generic lifecycle writer is RETIRED and the runtime
    // vocabulary is five-state, so this fixture stages HISTORICAL closed
    // evidence with raw SQL exactly as production history looks — the suite
    // verifies classification of legacy traces, not a live writer.
    const close = async ticket => {
      const current = await store.getTicket(ticket.id);
      const changedAt = new Date().toISOString();
      const updated = await store.pool.query(
        `UPDATE ${store.schema}.tickets
         SET status = 'closed', revision = revision + 1,
             body = body || $2::jsonb, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [ticket.id, JSON.stringify({ changedBy: ACTOR, changedAt })]
      );
      await store.pool.query(
        `INSERT INTO ${store.schema}.events
           (id, schema_version, ts, type, ticket_id, payload)
         VALUES (gen_random_uuid(), 1, $2::timestamptz, 'ticket.updated', $1, $3::jsonb)`,
        [ticket.id, changedAt, JSON.stringify({
          previousStatus: current.status, status: 'closed',
          changedBy: ACTOR, changedAt
        })]
      );
      await store.pool.query(
        `INSERT INTO ${store.schema}.diagnostic_logs
           (occurred_at, context_ticket_id, type, body)
         VALUES ($2::timestamptz, $1, 'ticket:status_change', $3::jsonb)`,
        [ticket.id, changedAt, JSON.stringify({
          ticketId: ticket.id, changedBy: ACTOR, changedAt,
          fromStatus: current.status, toStatus: 'closed'
        })]
      );
      return store.getTicket(ticket.id).then(row => ({ ...row, raw: updated.rowCount }));
    };

    const openTicket = await makeTicket('classifier open');
    const inProgress = await makeTicket('classifier in progress');
    await admit(inProgress);
    const completed = await makeTicket('classifier completed');
    const completedAdmission = await admit(completed);
    await terminalize(completedAdmission.runs[0]);
    await store.transitionTicketAfterRun({ runId: completedAdmission.runs[0].id });
    const closedCompleted = await close(completed);
    check(closedCompleted.status === 'closed', 'completed fixture closed through legacy writer');

    const failed = await makeTicket('classifier failed');
    const failedAdmission = await admit(failed);
    const failedOwner = `${ACTOR}-failed-${failedAdmission.runs[0].id}`;
    const failedClaim = await store.claimPendingRun({
      leaseOwner: failedOwner,
      leaseDurationMs: 60_000,
      eligibleRunIds: [failedAdmission.runs[0].id]
    });
    const failedStarted = await store.startClaimedRun({
      runId: failedAdmission.runs[0].id,
      leaseOwner: failedOwner,
      leaseDurationMs: 60_000
    });
    await store.transitionRun({
      runId: failedAdmission.runs[0].id,
      expectedRevision: failedStarted.run.revision,
      fromStatuses: ['running'],
      toStatus: 'failed',
      leaseOwner: failedOwner,
      eventType: 'run.failed',
      eventPayload: { source: ACTOR }
    });
    await store.transitionTicketAfterRun({ runId: failedAdmission.runs[0].id });
    await store.pool.query(
      `UPDATE "${legacySchema}".tickets SET status = 'failed', revision = revision + 1 WHERE id = $1`,
      [failed.id]
    );
    await close(failed);

    const blocked = await makeTicket('classifier blocked', 'blocked', {
      triage: { required: true, createdAt: new Date().toISOString(), resolvedAt: null }
    });
    const closedOpen = await close(openTicket);
    check(closedOpen.status === 'closed', 'open fixture closed through legacy writer');

    const interrupted = await close(inProgress);
    const currentRun = (await store.listRunsForTicket({ ticketId: inProgress.id, limit: 10 })).runs[0];
    const interruptionOwner = `${ACTOR}-interrupt-${currentRun.id}`;
    const interruptionClaim = await store.claimPendingRun({
      leaseOwner: interruptionOwner,
      leaseDurationMs: 60_000,
      eligibleRunIds: [currentRun.id]
    });
    const interruptionStarted = await store.startClaimedRun({
      runId: currentRun.id,
      leaseOwner: interruptionOwner,
      leaseDurationMs: 60_000
    });
    const interruptedRun = await store.transitionRun({
      runId: currentRun.id,
      expectedRevision: interruptionStarted.run.revision,
      fromStatuses: ['running'],
      toStatus: 'interrupted',
      leaseOwner: interruptionOwner,
      eventType: 'run.terminalized',
      eventPayload: { status: 'interrupted', source: ACTOR }
    });
    await store.appendRunLog({
      run: interruptedRun.run,
      type: 'run:interrupted',
      message: `${ACTOR} closed ticket #${inProgress.id}`,
      metadata: { ticketId: inProgress.id }
    });
    check(interrupted.status === 'closed' && interruptedRun.run.status === 'interrupted',
      'in-progress fixture has a matched closure interruption consequence');

    // Snapshot all tables read by the classifier. Setup mutations above are
    // complete; the child command must make no logical database change.
    const snapshot = async () => {
      const tables = ['tickets', 'ticket_attempts', 'runs', 'allocation_plans',
        'run_consequences', 'replay_snapshots', 'operation_receipts', 'events',
        'diagnostic_logs'];
      const values = {};
      for (const table of tables) {
        const result = await store.pool.query(`SELECT row_to_json(row) AS row FROM "${legacySchema}"."${table}" AS row ORDER BY row_to_json(row)::text`);
        values[table] = result.rows.map(item => item.row);
      }
      return JSON.stringify(values);
    };
    const before = await snapshot();
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 't2-classifier-'));
    const firstReportPath = path.join(tempDirectory, 'first.json');
    const secondReportPath = path.join(tempDirectory, 'second.json');
    const expectedDatabase = new URL(databaseUrl).pathname.slice(1);
    const runClassifier = reportPath => execFileSync(process.execPath, [
      'scripts/t2-five-state-classifier.js',
      '--database-url-env', 'TEST_DATABASE_URL',
      '--schema', legacySchema,
      '--expected-database', expectedDatabase,
      '--report', reportPath
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
      encoding: 'utf8'
    });
    runClassifier(firstReportPath);
    const middle = await snapshot();
    runClassifier(secondReportPath);
    const after = await snapshot();
    const firstReport = fs.readFileSync(firstReportPath, 'utf8');
    const secondReport = fs.readFileSync(secondReportPath, 'utf8');
    const parsed = JSON.parse(firstReport);
    check(parsed.schemaVersion === 1, 'report declares classifier schema version');
    check(parsed.summary.total >= 5, 'report enumerates every synthetic Ticket');
    check(firstReport === secondReport, 'repeated classifier report is byte-identical');
    check(before === middle && middle === after,
      'classifier phase leaves all read tables logically unchanged');
    check(parsed.summary.closedClassification.proven_canceled >= 2,
      `report classifies open and in-progress legacy closes as canceled candidates: ${JSON.stringify(parsed.tickets.map(ticket => ({ id: ticket.ticketId, status: ticket.legacyStatus, classification: ticket.closedClassification, reasons: ticket.reasons })))}`);
    check(parsed.summary.closedClassification.proven_not_canceled >= 1,
      'report classifies pre-close completion as not canceled');
    check(parsed.summary.proposedLifecycle.blocked >= 1,
      'report retains reconstructable blocker authority');
    console.log(`  ${assertions} assertions passed`);
    await store.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
    await pool.end();
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
