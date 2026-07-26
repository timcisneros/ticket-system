#!/usr/bin/env node
'use strict';
// A17 proof 5 — required reconciliation evidence must survive a rejected log.
//
// `run:reconciled` is required audit evidence about an ALREADY-TERMINAL run, so
// no execution loop follows it and no later drain can consume its failure. The
// settle boundary must therefore record the failure through the replay authority
// (recordReplayEvent), which does not route through appendRunLog and so cannot
// re-enter the path that just failed.
//
// Fixture: run a ticket to completion, then push the runs row back to 'running'
// with an already-expired lease. The scheduler's stale-lease sweep then finds a
// run whose events show terminal state but whose row does not, which is exactly
// the safeToReconcileTerminalState path that emits `run:reconciled`.
//
// The rejection is delayed (pg_sleep) so a non-draining settle boundary would
// race past it. Trigger firing is proven by a sequence, whose increments survive
// the rollback that RAISE EXCEPTION causes.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
const TARGET_LOG_TYPE = 'run:terminalized';           // interruptStaleRunsOnStartup
const TARGET_LOG_TYPE_B = 'run:ticket_finalized';     // reconcileUnfinalizedTicketsOnStartup

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `a17-reconcile-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'a17-reconcile']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '').join('\\n');
  const match = combined.match(/a17-reconcile ([A-Za-z0-9._-]+)/);
  if (match) {
    return ok({
      message: 'Writing the requested file.',
      actions: [{ operation: 'writeFile', args: { path: match[1], content: 'reconcile' } }],
      complete: true
    });
  }
  return ok({ message: 'No matching objective.', actions: [], complete: true });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function installTrigger(store, schema) {
  await store.pool.query(`
    CREATE SEQUENCE "${schema}".a17_reconcile_fires;
    CREATE FUNCTION "${schema}".a17_reject_reconciled() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.type IN ('${TARGET_LOG_TYPE}', '${TARGET_LOG_TYPE_B}') THEN
        PERFORM nextval('"${schema}".a17_reconcile_fires');
        PERFORM pg_sleep(0.25);
        RAISE EXCEPTION 'A17 injected reconciliation log failure';
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER a17_reject_reconciled
      BEFORE INSERT ON "${schema}".diagnostic_logs
      FOR EACH ROW EXECUTE FUNCTION "${schema}".a17_reject_reconciled();
  `);
}

async function removeTrigger(store, schema) {
  await store.pool.query(`
    DROP TRIGGER IF EXISTS a17_reject_reconciled ON "${schema}".diagnostic_logs;
    DROP FUNCTION IF EXISTS "${schema}".a17_reject_reconciled();
  `);
}

async function fireCount(store, schema) {
  const { rows } = await store.pool.query(
    `SELECT last_value, is_called FROM "${schema}".a17_reconcile_fires`
  );
  if (!rows.length) return 0;
  return rows[0].is_called ? Number(rows[0].last_value) : 0;
}

async function main() {
  const preloadPath = createPreload();
  await withHarness('reconciliation evidence failure', async ({ store, schema, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `A17Reconcile${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
      groupIds: [], changedBy: 'a17-reconcile-test'
    })).agent;

    const env = {
      NODE_OPTIONS: `--require ${preloadPath}`,
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      RUN_LEASE_DURATION_MS: '3000',
      AGENT_MAX_EXECUTION_STEPS: '4',
      AGENT_MAX_RUNTIME_DURATION_MS: '30000'
    };

    const now = () => new Date().toISOString();
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective: `a17 reconciliation evidence ${STAMP}`, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
        ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
        workflowId: null, workflowInput: null,
        capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
          allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        status: 'open', createdBy: 'admin', changedBy: 'admin', changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'a17-reconcile-test' }
    })).ticket;

    // Terminal EVIDENCE committed while the row still reads 'running' with an
    // expired lease. The sweep then finds safeToReconcileTerminalState, which is
    // the only path that emits the required `run:reconciled` audit log.
    const run = await store.createRun({
      ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });
    const claim = await store.claimPendingRun({
      leaseOwner: 'a17-fixture', leaseDurationMs: 60000, eligibleRunIds: [run.id]
    });
    const started = await store.transitionRun({
      runId: run.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
      toStatus: 'running', leaseOwner: 'a17-fixture', eventType: 'run.started'
    });
    assert(started.run.status === 'running', 'the fixture run row reads running');
    await store.appendEvent({
      type: 'run.terminalized', ticketId: ticket.id, runId: run.id,
      payload: { status: 'interrupted', simulatedProjectionGap: true }
    });
    await store.pool.query(
      `UPDATE "${schema}".runs
          SET lease_expires_at = clock_timestamp() - interval '1 second',
              revision = revision + 1, updated_at = clock_timestamp()
        WHERE id = $1`, [run.id]
    );
    assert((await store.getRun(run.id)).status === 'running',
      'terminal evidence exists while the row still reads running');

    // ── Fixture B: reconcileUnfinalizedTicketsOnStartup / run:ticket_finalized ──
    // A ticket stuck at in_progress whose latest run is genuinely terminal and
    // carries run.terminalized. Startup finalizes the ticket and logs the required
    // audit line, which the trigger rejects.
    const ticketB = (await store.createTicketWithEvent({
      ticket: {
        objective: `a18 unfinalized ticket ${STAMP}`, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
        ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
        workflowId: null, workflowInput: null,
        capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
          allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        status: 'in_progress', createdBy: 'admin', changedBy: 'admin',
        changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'a17-reconcile-test' }
    })).ticket;

    const runB = await store.createRun({
      ticketId: ticketB.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });
    const claimB = await store.claimPendingRun({
      leaseOwner: 'a17-fixture-b', leaseDurationMs: 60000, eligibleRunIds: [runB.id]
    });
    const startedB = await store.transitionRun({
      runId: runB.id, expectedRevision: claimB.run.revision, fromStatuses: ['pending'],
      toStatus: 'running', leaseOwner: 'a17-fixture-b', eventType: 'run.started'
    });
    await store.transitionRun({
      runId: runB.id, expectedRevision: startedB.run.revision, fromStatuses: ['running'],
      toStatus: 'completed', leaseOwner: 'a17-fixture-b', eventType: 'run.execution_completed',
      eventPayload: { status: 'completed' }
    });
    await store.appendEvent({
      type: 'run.terminalized', ticketId: ticketB.id, runId: runB.id,
      payload: { status: 'completed' }
    });
    assert((await store.getTicket(ticketB.id)).status === 'in_progress',
      'fixture B ticket is stuck at in_progress with a terminal run');

    await installTrigger(store, schema);

    const second = await startServer(env);
    const cookie = await second.login();

    // Wait for the sweep to attempt reconciliation (proven by the trigger firing).
    await waitFor(async () => (await fireCount(store, schema)) >= 1, 60000,
      'the reconciliation log insert to be attempted');
    const fires = await fireCount(store, schema);
    assert(fires >= 1, `the intended ${TARGET_LOG_TYPE} insert was attempted and rejected (${fires} fires)`);

    // The settle boundary must have written durable structured evidence.
    const evidence = await waitFor(async () => {
      const replay = await store.readRunReplay(run.id);
      const events = (replay && replay.snapshot && replay.snapshot.events) || [];
      return events.find(e => e && e.type === 'run.reconciliation_evidence_failed') || null;
    }, 60000, 'run.reconciliation_evidence_failed to be persisted through replay authority');

    assert(Boolean(evidence),
      'run.reconciliation_evidence_failed is persisted through the replay authority');
    const detail = (evidence.payload && evidence.payload.evidenceFailure) || evidence.evidenceFailure || {};
    assert(detail.logType === TARGET_LOG_TYPE,
      `the evidence payload records the original log type (${detail.logType})`);
    assert(detail.kind === 'evidence_persistence',
      `the evidence payload carries the evidence_persistence classification (${detail.kind})`);
    assert(detail.code === 'P0001',
      `the evidence payload records the database error code (${detail.code})`);
    assert(typeof detail.message === 'string' && /injected reconciliation log failure/.test(detail.message),
      'the evidence payload records the database error message');

    // Reconciliation must be visibly evidence-incomplete, not cleanly reconciled.
    const replay = await store.readRunReplay(run.id);
    const events = (replay && replay.snapshot && replay.snapshot.events) || [];
    assert(events.some(e => e && e.type === 'run.reconciliation_evidence_failed'),
      'reconciliation is visibly evidence-incomplete in durable replay evidence');

    // No recursive diagnostic-log attempt: the trigger must have fired once.

    const stderr = second.output();
    assert(!/unhandledRejection|UnhandledPromiseRejection/i.test(stderr),
      'no unhandled process rejection occurred during reconciliation');

    const health = await second.request('GET', '/health');
    assert(health.statusCode === 200, 'the server process remained alive through reconciliation');

    // ── Proof 8b: reconcileUnfinalizedTicketsOnStartup settle boundary ────────
    const evidenceB = await waitFor(async () => {
      const replay = await store.readRunReplay(runB.id);
      const events = (replay && replay.snapshot && replay.snapshot.events) || [];
      return events.find(e => e && e.type === 'run.reconciliation_evidence_failed') || null;
    }, 60000, 'ticket-finalized evidence failure to be persisted through replay authority');

    assert(Boolean(evidenceB),
      'a rejected run:ticket_finalized log produces durable replay evidence');
    const detailB = (evidenceB.payload && evidenceB.payload.evidenceFailure) || {};
    assert(detailB.logType === TARGET_LOG_TYPE_B,
      `the ticket-finalized evidence records its own log type (${detailB.logType})`);
    assert(detailB.kind === 'evidence_persistence',
      'the ticket-finalized evidence carries the evidence_persistence classification');
    assert((await store.getTicket(ticketB.id)).status !== 'in_progress',
      'the ticket transition itself still completed');

    // Two fixtures, each rejecting exactly one required log. More than one attempt
    // per fixture would mean containment re-entered the failing log path.
    const finalFires = await fireCount(store, schema);
    assert(finalFires === 2,
      `no recursive diagnostic-log attempt occurred: exactly one per fixture (${finalFires})`);

    await removeTrigger(store, schema);

    const later = await second.request('GET', '/tickets', { cookie });
    assert(later.statusCode === 200, 'a later authenticated request still succeeds');

    console.log(`\nPASS: reconciliation evidence failure — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'a17_reconcile' });
}

main().catch(error => {
  console.error(`\nFAIL: reconciliation evidence failure — ${error && error.message ? error.message : error}`);
  process.exit(1);
});
