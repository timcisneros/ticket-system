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
  await withHarness('t2 five-state classifier', async ({ store, schema, databaseUrl }) => {
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
    const close = async ticket => {
      const current = await store.getTicket(ticket.id);
      const changedAt = new Date().toISOString();
      const transitioned = await store.transitionTicketState({
        ticketId: ticket.id,
        fromStatuses: [current.status],
        toStatus: 'closed',
        patch: { changedBy: ACTOR, changedAt },
        eventPayload: { changedBy: ACTOR, changedAt }
      });
      await store.appendSystemLog({
        type: 'ticket:status_change',
        message: `Ticket #${ticket.id} status changed from ${current.status} to closed by ${ACTOR}`,
        metadata: {
          ticketId: ticket.id,
          changedBy: ACTOR,
          changedAt,
          fromStatus: current.status,
          toStatus: 'closed'
        }
      });
      return transitioned.ticket;
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
      `UPDATE "${schema}".tickets SET status = 'failed', revision = revision + 1 WHERE id = $1`,
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
        const result = await store.pool.query(`SELECT row_to_json(row) AS row FROM "${schema}"."${table}" AS row ORDER BY row_to_json(row)::text`);
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
      '--schema', schema,
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
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
