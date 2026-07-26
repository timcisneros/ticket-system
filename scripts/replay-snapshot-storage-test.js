#!/usr/bin/env node
'use strict';
// Replay-snapshot storage separation — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// SURVIVING CONTRACT: a run's replay snapshot is stored SEPARATELY from the run
// record, and every consumer hydrates it from that separate record rather than from
// anything inline on the run. The run row stays metadata-only; the snapshot round
// trips without loss; and the operator surfaces that read it — the run detail page
// and the `oquery` CLI — reconstruct the run from it faithfully.
//
// RETIRED FROM THE JSON-ERA SUITE, deliberately and not by omission: the original
// spent its first third driving `scripts/extract-replay-snapshots.js`, a one-shot
// migration that lifted an inline `run.replaySnapshot` out of `runs.json` into
// `data/replay-snapshots/run-N.json` and left a `replaySnapshotPath` pointer behind.
// That helper reads `DATA_DIR`, which the PostgreSQL runtime does not read at all,
// and the storage layout it produced no longer exists — separation is now structural
// (a `replay_snapshots` table keyed by run id), not the product of a migration step.
// Asserting the helper would assert a dead mechanism. The helper itself is a residual
// JSON-era artifact and is recorded as such in the A10 entry.
//
// What survives is the PROPERTY the migration existed to establish, which is what
// this suite now asserts directly against the store.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const assert = createAsserter();

// jsonb does not preserve key insertion order, so equality must be structural.
// Element order inside arrays IS part of the contract and is compared positionally.
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;
    return aKeys.every(key => deepEqual(a[key], b[key]));
  }
  return false;
}

function runOquery(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(ROOT, 'scripts/oquery.js'), ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, timeout: 60000
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function main() {
  await withHarness('replay snapshot storage', async ({ store, workspaceRoot, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `ReplayStorage-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-replay-storage' },
      groupIds: [], changedBy: 'replay-snapshot-storage-test'
    })).agent;

    const now = () => new Date().toISOString();
    const objective = `replay snapshot storage fixture ${STAMP}`;

    const ticket = (await store.createTicketWithEvent({
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
        status: 'failed', createdBy: 'admin', changedBy: 'admin',
        changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'replay-snapshot-storage-test' }
    })).ticket;

    // Established A10 fixture pattern for a terminal run carrying crafted replay
    // evidence: create → claim → running → terminal → initializeRunReplay. Direct
    // UPDATEs are rejected by the revision and terminal-reopen guards.
    const created = await store.createRun({
      ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });
    const claim = await store.claimPendingRun({
      leaseOwner: 'replay-storage-fixture', leaseDurationMs: 60000, eligibleRunIds: [created.id]
    });
    const started = await store.transitionRun({
      runId: created.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
      toStatus: 'running', leaseOwner: 'replay-storage-fixture', eventType: 'run.started'
    });
    await store.transitionRun({
      runId: created.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
      toStatus: 'failed', leaseOwner: 'replay-storage-fixture', eventType: 'run.execution_failed',
      eventPayload: { status: 'failed' }
      // Deliberately NO error patch on the run row: the failure text below must be
      // attributable to the replay record alone, which is the point of the suite.
    });

    // Deliberately nested and multi-element so the round-trip assertion is about
    // structure, not just scalars.
    const snapshot = {
      version: 1, runId: created.id, ticketId: ticket.id,
      assignedAgentId: agent.id, agentNameSnapshot: agent.name,
      provider: 'openai', model: 'gpt-4.1-mini',
      runtimeEnvelope: { maxExecutionSteps: 4, allowedOperations: ['listDirectory', 'readFile', 'writeFile'] },
      ticketObjectiveSnapshot: objective, systemInstructionSnapshot: 'fixture',
      primitiveContract: {}, workspaceRoot, mainWorkspaceRoot: workspaceRoot,
      executionWorkspaceType: 'main',
      runtimeLimits: { maxExecutionSteps: 4, maxModelRequestsPerRun: 4, maxWorkspaceOperationsPerRun: 32 },
      providerRequests: [{ requestId: 'fixture-request-1' }, { requestId: 'fixture-request-2' }],
      modelResponses: [{ text: '{"actions":[],"complete":false}' }],
      parsedModelPlans: [{ step: 0, actions: [], complete: false }],
      workspaceOperations: [],
      events: [{ type: 'model:no_progress', message: 'fixture no progress', step: 0 }],
      terminalStatus: 'failed',
      failureReason: 'fixture structured failure',
      failure: { code: 'RUN_LIMIT_EXCEEDED', kind: 'no_progress', detail: { limitType: 'execution_steps' } },
      mutationCount: 0, mutationOutcome: 'no_mutations',
      createdAt: now(), finalizedAt: now()
    };
    await store.initializeRunReplay({ runId: created.id, ticketId: ticket.id, snapshot });

    // ── 1. The run record stays metadata-only ────────────────────────────────
    const run = await store.getRun(created.id);
    assert(Boolean(run) && run.status === 'failed', '1: the fixture run is terminal in the store');
    assert(run.replaySnapshot === undefined,
      '1: the run record carries no inline replay snapshot');
    assert(run.replaySnapshotPath === undefined,
      '1: the run record carries no JSON-era replay snapshot pointer either');

    // Separation is structural, not a convention of the row mapper: the runs table
    // itself must hold no snapshot payload.
    const rawRun = await store.pool.query(
      `SELECT * FROM ${store.table('runs')} WHERE id = $1`, [created.id]
    );
    const rawColumns = Object.keys(rawRun.rows[0]);
    assert(!rawColumns.some(column => /replay/i.test(column)),
      '1: the runs table has no replay-snapshot column');
    const rawBody = JSON.stringify(rawRun.rows[0]);
    assert(!rawBody.includes('fixture-request-1'),
      '1: no replay evidence is embedded anywhere in the run row');

    // ── 2. The snapshot round-trips through its own record ───────────────────
    const record = await store.readRunReplay(created.id);
    assert(Boolean(record) && Boolean(record.snapshot), '2: the replay record exists for the run');
    assert(deepEqual(record.snapshot, snapshot),
      '2: the snapshot round-trips structurally intact through jsonb');
    assert(record.snapshot.providerRequests[0].requestId === 'fixture-request-1'
      && record.snapshot.providerRequests[1].requestId === 'fixture-request-2',
      '2: array element order inside the snapshot is preserved');

    const batch = await store.listRunReplays({ runIds: [created.id] });
    assert(batch.length === 1 && deepEqual(batch[0].snapshot, snapshot),
      '2: the batch read returns the same snapshot as the single read');

    // ── 3. Consumers hydrate from the separate record ────────────────────────
    const server = await startServer({});
    const cookie = await server.login();

    const runDetail = await server.request('GET', `/runs/${created.id}`, { cookie });
    assert(runDetail.statusCode === 200, `3: run detail returned HTTP ${runDetail.statusCode}`);
    assert(/2 provider request\(s\)/.test(runDetail.body.replace(/\s+/g, ' ')),
      '3: run detail reports the provider-request count only the snapshot can supply');
    assert(runDetail.body.includes('fixture structured failure'),
      '3: run detail surfaces the failure reason carried by the snapshot');

    // The CLI is a separate consumer reaching the same record over a separate code
    // path, which is what makes this a storage assertion rather than a rendering one.
    const cookieFile = path.join(os.tmpdir(), `replay-storage-cookie-${process.pid}-${STAMP}`);
    const oqueryEnv = {
      OPERC_URL: server.baseUrl,
      OPERC_COOKIE_PATH: cookieFile,
      OPERC_USERNAME: 'admin',
      OPERC_PASSWORD: 'admin123'
    };
    try {
      const loggedIn = await runOquery(['login'], oqueryEnv);
      assert(fs.existsSync(cookieFile),
        `3: oquery authenticated against the harness server (${loggedIn.stdout.trim().slice(0, 200)})`);

      const replayOut = await runOquery(['replay', String(created.id)], oqueryEnv);
      assert(replayOut.stdout.includes(`Replay: Run #${created.id}`),
        '3: oquery replay hydrates the snapshot from its own record');

      const failuresOut = await runOquery(['failures', '--run', String(created.id)], oqueryEnv);
      assert(failuresOut.stdout.includes('NO_PROGRESS'),
        '3: oquery failures classifies the run from the hydrated snapshot');
    } finally {
      try { fs.unlinkSync(cookieFile); } catch (_) { /* best effort */ }
    }

    // ── 4. Neighbouring surfaces still render ────────────────────────────────
    // Cheap regression guard kept from the original: a run whose evidence lives in
    // a separate record must not break list pages that only read run metadata.
    const tickets = await server.request('GET', '/tickets?limit=1', { cookie });
    assert(tickets.statusCode === 200, `4: tickets page returned HTTP ${tickets.statusCode}`);
    const agents = await server.request('GET', '/agents', { cookie });
    assert(agents.statusCode === 200, `4: agents page returned HTTP ${agents.statusCode}`);

    console.log(`\nPASS: replay snapshot storage separation — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'replay_snapshot_storage' });
}

main().catch(error => {
  console.error(`\nFAIL: replay snapshot storage separation — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
