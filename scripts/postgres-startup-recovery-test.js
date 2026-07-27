#!/usr/bin/env node
'use strict';
// PostgreSQL-native startup recovery integration test — the replacement that
// executes the REAL server startup path (interruptStaleRunsOnStartup), not the
// pure classifier. It is the coverage successor to two retired JSON tests whose
// invariants the classifier alone cannot prove:
//
//   reconciliation-flow-test      — a partially terminalized run is discovered
//                                   on startup and ONLY the missing
//                                   terminalization work is completed, once.
//   resume-terminal-mismatch-test — a run with committed terminal evidence but
//                                   a non-terminal (running) row is repaired to
//                                   terminal and NEVER resumed.
//
// Both crash states are seeded through the store BEFORE boot (the same recipes
// postgres-persistence-integration-test uses), then a real server boots with
// startup recovery ENABLED (no TEST_SKIP_STARTUP_RUN_RECOVERY). A second boot
// proves the startup path is idempotent — no duplicate terminal work.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { seedTerminalRun } = require('./postgres-operator-fixture');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');
const { allocateTestPort } = require('./test-port');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the startup recovery test');
  process.exit(1);
}

const SCHEMA = `startup_recovery_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
let PORT = null;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-recovery-ws-'));

function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function allEvents(store, runId) {
  const events = [];
  let afterSeq = -1;
  while (true) {
    const page = await store.listRunEvents(runId, { afterSeq, limit: 100 });
    if (!Array.isArray(page) || page.length === 0) break;
    events.push(...page);
    afterSeq = page[page.length - 1].seq;
  }
  return events;
}
const countType = (events, type) => events.filter(e => e.type === type).length;

function bootServer() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL,
      POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'startup-recovery-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
      PORT,
      WORKSPACE_ROOT,
      // Startup recovery ENABLED (this is the whole point); schedulers idle so
      // only the startup path acts on the seeded runs.
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });
  return { server, out: () => out };
}

async function waitReady(handle) {
  for (let i = 0; i < 80; i++) {
    if (handle.server.exitCode !== null) throw new Error('server exited during startup:\n' + handle.out().slice(-3000));
    try { if ((await fetch(`http://127.0.0.1:${PORT}/login`)).status === 200) return; } catch (_) {}
    await sleep(400);
  }
  throw new Error('server did not become ready:\n' + handle.out().slice(-3000));
}

async function stop(handle) {
  handle.server.kill('SIGTERM');
  await sleep(1000);
  if (handle.server.exitCode === null) handle.server.kill('SIGKILL');
  await sleep(300);
}

const LEASE_OWNER = 'startup-recovery-seed';

async function main() {
  // OS-allocated ephemeral port: see scripts/test-port.js. Fixed or pid-derived
  // ports collided across suites and surfaced as a misleading start failure.
  PORT = String(await allocateTestPort());
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
  await store.migrate();

  try {
    const agent = (await store.createConfiguredAgent({
      value: { name: 'Startup Recovery Agent', provider: 'ollama', model: 'mock', apiKey: '' },
      groupIds: [], changedBy: 'startup-recovery-test'
    })).agent;

    const now = () => new Date().toISOString();
    const makeTicket = async objective => (await store.createTicketWithEvent({
      ticket: {
        objective, acceptanceCriteria: null,
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
      eventPayload: { source: 'startup-recovery-test' }
    })).ticket;

    // ── Path A: partially terminalized run (row reached a terminal status via
    // run.execution_completed, but the terminalization tail — snapshot_finalized
    // / evaluation / consequence / terminalized — was never written). ──
    const ticketA = await makeTicket('partial terminalization run');
    const runA = await store.createRun({
      ticketId: ticketA.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });
    const claimA = await store.claimPendingRun({ leaseOwner: LEASE_OWNER, leaseDurationMs: 60_000, eligibleRunIds: [runA.id] });
    const startedA = await store.transitionRun({
      runId: runA.id, expectedRevision: claimA.run.revision, fromStatuses: ['pending'],
      toStatus: 'running', leaseOwner: LEASE_OWNER, eventType: 'run.started'
    });
    await store.transitionRun({
      runId: runA.id, expectedRevision: startedA.run.revision, fromStatuses: ['running'],
      toStatus: 'completed', leaseOwner: LEASE_OWNER, eventType: 'run.execution_completed',
      eventPayload: { status: 'completed' }
    });

    // ── Path B: terminal evidence committed, but the run row is still 'running'
    // with an expired lease (the projection update was lost to a crash). ──
    const ticketB = await makeTicket('terminal evidence with running row');
    const runB = await store.createRun({
      ticketId: ticketB.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });
    const claimB = await store.claimPendingRun({ leaseOwner: LEASE_OWNER, leaseDurationMs: 60_000, eligibleRunIds: [runB.id] });
    const startedB = await store.transitionRun({
      runId: runB.id, expectedRevision: claimB.run.revision, fromStatuses: ['pending'],
      toStatus: 'running', leaseOwner: LEASE_OWNER, eventType: 'run.started'
    });
    await store.appendEvent({
      type: 'run.terminalized', ticketId: runB.ticketId, runId: runB.id,
      payload: { status: 'interrupted', simulatedProjectionGap: true }
    });
    // Expire the lease so the run is a process_restart recoverable while the row
    // still reads 'running'.
    await store.pool.query(
      `UPDATE ${store.table('runs')} SET lease_expires_at = clock_timestamp() - interval '1 second',
         revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1`,
      [runB.id]
    );
    assert((await store.getRun(runB.id)).status === 'running', 'Path B row must read running before startup');

    // ── Path C (control): a fully terminal run. Startup must leave it untouched. ──
    const ticketC = await makeTicket('already terminal control');
    const runC = await seedTerminalRun(store, {
      ticket: ticketC, agent, status: 'completed',
      replaySnapshot: {
        terminalStatus: 'completed', parsedModelPlans: [], providerRequests: [],
        modelResponses: [], workspaceOperations: [], events: []
      },
      verificationEvent: { type: 'run.verification_passed', payload: { status: 'passed' } },
      evaluation: {
        effectiveness: { status: 'passed', postconditionsPassed: 0, postconditionsFailed: 0, errors: [] },
        efficiency: { durationMs: 1, workflowSteps: 0, providerRequests: 0, modelResponses: 0, workspaceOperations: 0, mutationCount: 0, retryCount: 0 },
        violations: { status: 'none', items: [] }
      },
      consequence: { mutations: [], created: [], updated: [], renamed: [], deleted: [], notifications: [], externalEffects: [], verification: { postconditionsStatus: 'passed', violationsStatus: 'none' } }
    });
    const controlEventCountBefore = (await allEvents(store, runC.id)).length;

    // ── Boot 1: startup recovery runs before the server accepts requests. ──
    let handle = bootServer();
    await waitReady(handle);

    // Path A: only the missing terminalization work was completed — exactly once.
    const eventsA1 = await allEvents(store, runA.id);
    assert(countType(eventsA1, 'run.terminalized') === 1, `Path A must have exactly one run.terminalized, got ${countType(eventsA1, 'run.terminalized')}`);
    assert(countType(eventsA1, 'run.evaluation_completed') === 1, `Path A must record evaluation once, got ${countType(eventsA1, 'run.evaluation_completed')}`);
    assert(countType(eventsA1, 'run.consequence_recorded') === 1, `Path A must record consequence once, got ${countType(eventsA1, 'run.consequence_recorded')}`);
    assert(countType(eventsA1, 'run.snapshot_finalized') + countType(eventsA1, 'replay.snapshot.finalized') === 1, 'Path A must finalize the replay snapshot once');
    assert(countType(eventsA1, 'run.execution_completed') === 1, 'Path A must not duplicate the pre-existing execution_completed event');
    const runARow1 = await store.getRun(runA.id);
    assert(['completed', 'failed', 'interrupted'].includes(runARow1.status), `Path A row must be terminal, got ${runARow1.status}`);
    assert(verifyCurrentRunEventChain(eventsA1).chainValid, 'Path A event chain must remain valid after reconciliation');

    // Path B: repaired to terminal, never resumed, no duplicate terminal work.
    const eventsB1 = await allEvents(store, runB.id);
    const runBRow1 = await store.getRun(runB.id);
    assert(runBRow1.status === 'interrupted', `Path B row must be repaired to the terminalized payload status, got ${runBRow1.status}`);
    assert(runBRow1.leaseOwner === null, 'Path B lease must be cleared after repair');
    assert(countType(eventsB1, 'run.terminalized') === 1, `Path B must not duplicate terminalization, got ${countType(eventsB1, 'run.terminalized')}`);
    assert(countType(eventsB1, 'run.started') === 1, 'Path B must not be resumed (no second run.started)');
    assert(!eventsB1.some(e => e.type === 'run.resumed'), 'Path B must never be resumed');
    assert(countType(eventsB1, 'run.terminal_projection_repaired') === 1, 'Path B must record exactly one terminal projection repair');
    assert(verifyCurrentRunEventChain(eventsB1).chainValid, 'Path B event chain must remain valid after repair');

    // Path C: untouched.
    assert((await allEvents(store, runC.id)).length === controlEventCountBefore, 'control terminal run must be left untouched by startup');

    await stop(handle);

    // ── Boot 2: idempotency — the now fully-terminal runs must not be touched
    // again, no duplicate terminal work across restarts. ──
    const beforeA = (await allEvents(store, runA.id)).length;
    const beforeB = (await allEvents(store, runB.id)).length;
    handle = bootServer();
    await waitReady(handle);
    const afterA = await allEvents(store, runA.id);
    const afterB = await allEvents(store, runB.id);
    assert(afterA.length === beforeA, `second startup must not add Path A events (${beforeA} → ${afterA.length})`);
    assert(afterB.length === beforeB, `second startup must not add Path B events (${beforeB} → ${afterB.length})`);
    assert(countType(afterA, 'run.terminalized') === 1 && countType(afterB, 'run.terminalized') === 1, 'no duplicate terminalization across restarts');
    await stop(handle);

    console.log('PASS: postgres startup recovery — partial terminalization completed once, terminal-evidence/running-row repaired without resume, control untouched, idempotent across restarts');
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
