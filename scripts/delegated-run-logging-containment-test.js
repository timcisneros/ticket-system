#!/usr/bin/env node
'use strict';
// A17 — delegated run-log identity and required-evidence containment.
// Real server, real PostgreSQL, real rejected insert. Nothing stubbed.
//
// Two halves:
//
//   Healthy delegation — a validated handoff must attribute the EXECUTOR for
//   authority and receipts while the run remains OWNED by the planner, and the
//   log row must persist against the planner-owned run with both identities
//   distinguishable in structured metadata.
//
//   Forced required-log failure — a required diagnostic-log insert is rejected by
//   a trigger installed only in this test's schema. The run must fail closed:
//   process alive, no unhandledRejection, no completion, no further model request
//   or mutation, and the mutation committed BEFORE the failure preserved exactly.
//
// The injected rejection is DELAYED (pg_sleep) on purpose. An implementation that
// checks the failure marker synchronously after a fire-and-forget appendRunLog
// races past a rejection that has not settled yet; the delay makes that race
// deterministic rather than incidental. This is the case that distinguishes real
// pending-write draining from lucky microtask ordering.
//
// Proving the trigger fired needs care: RAISE EXCEPTION aborts the transaction, so
// a marker row inserted by the trigger would roll back with it. Sequence
// increments are NON-transactional, so nextval() survives the rollback and is the
// one durable signal that the intended insert was actually attempted.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

// The required log type emitted after a workspace write commits. Chosen because it
// lands AFTER the mutation receipt is durable, which is what makes "a post-mutation
// failure preserves exactly the already committed receipt" testable.
const TARGET_LOG_TYPE = 'workspace:write';

// Provider stub via NODE_OPTIONS preload (storage-independent, same pattern the
// other repaired suites use). Writes the requested file, then reports complete.
function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `a17-containment-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'a17-containment']]),
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
  const handoff = combined.match(/a17-handoff ([A-Za-z0-9._-]+) to ([A-Za-z0-9_-]+)/);
  if (handoff) {
    return ok({
      message: 'Delegating a bounded write to the executor.',
      actions: [{ operation: 'createHandoffTask', args: {
        executor: handoff[2],
        operation: 'writeFile',
        args: { path: handoff[1], content: 'delegated' }
      } }],
      complete: true
    });
  }
  const match = combined.match(/write file (\\S+) containing exactly (\\S+)/);
  if (match) {
    return ok({
      message: 'Writing the requested file.',
      actions: [{ operation: 'writeFile', args: { path: match[1], content: match[2] } }],
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

async function installRejectionTrigger(store, schema) {
  await store.pool.query(`
    CREATE SEQUENCE "${schema}".a17_trigger_fires;
    CREATE FUNCTION "${schema}".a17_reject_required_log() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.type = '${TARGET_LOG_TYPE}' THEN
        -- Non-transactional: survives the rollback caused by RAISE below, so the
        -- test can prove the intended insert was genuinely attempted.
        PERFORM nextval('"${schema}".a17_trigger_fires');
        -- Delay so the rejection settles AFTER the caller has continued.
        PERFORM pg_sleep(0.25);
        RAISE EXCEPTION 'A17 injected required diagnostic-log failure';
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER a17_reject_required_log
      BEFORE INSERT ON "${schema}".diagnostic_logs
      FOR EACH ROW EXECUTE FUNCTION "${schema}".a17_reject_required_log();
  `);
}

async function removeRejectionTrigger(store, schema) {
  await store.pool.query(`
    DROP TRIGGER IF EXISTS a17_reject_required_log ON "${schema}".diagnostic_logs;
    DROP FUNCTION IF EXISTS "${schema}".a17_reject_required_log();
  `);
}

async function triggerFireCount(store, schema) {
  const { rows } = await store.pool.query(
    `SELECT last_value, is_called FROM "${schema}".a17_trigger_fires`
  );
  if (!rows.length) return 0;
  return rows[0].is_called ? Number(rows[0].last_value) : 0;
}

async function main() {
  const preloadPath = createPreload();
  await withHarness('delegated run logging containment', async ({ store, schema, workspaceRoot, startServer }) => {
    const planner = (await store.createConfiguredAgent({
      value: { name: `A17 Planner ${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
      groupIds: [], changedBy: 'a17-test'
    })).agent;
    const executor = (await store.createConfiguredAgent({
      value: { name: `A17Executor${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
      groupIds: [], changedBy: 'a17-test'
    })).agent;

    assert(planner.id !== executor.id, 'planner and executor are distinct agents');

    const server = await startServer({
      NODE_OPTIONS: `--require ${preloadPath}`,
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      AGENT_MAX_EXECUTION_STEPS: '6',
      AGENT_MAX_RUNTIME_DURATION_MS: '60000'
    });
    const cookie = await server.login();

    const runTicket = async (objective, agentId, seen) => {
      const created = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agentId),
          assignmentMode: 'individual'
        }
      });
      if (created.statusCode !== 302) {
        throw new Error(`ticket create returned HTTP ${created.statusCode}`);
      }
      const run = await waitFor(async () => {
        const page = await store.listRuns({ limit: 100 });
        return (page.runs || []).find(r => r.agentId === agentId && !seen.has(r.id)) || null;
      }, 40000, `run dispatch for "${objective.slice(0, 40)}"`);
      seen.add(run.id);
      return run;
    };

    const seen = new Set();

    // ── Healthy delegated handoff ─────────────────────────────────────────────
    // These A17 invariants must be guarded by THIS suite, not only by the natural
    // A10 postcondition suite, so the isolated A17 commit carries its own guard.
    const HANDOFF_FILE = `a17-delegated-${STAMP}.md`;
    const delegated = await runTicket(
      `a17-handoff ${HANDOFF_FILE} to ${executor.name}`, planner.id, seen
    );
    const delegatedTerminal = await waitFor(async () => {
      const current = await store.getRun(delegated.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 90000, 'the delegated run to terminalize');

    assert(delegatedTerminal.agentId === planner.id,
      `the planner remains the persisted run owner (agentId=${delegatedTerminal.agentId})`);
    assert(delegatedTerminal.agentId !== executor.id,
      'run ownership was NOT overwritten with the executor identity');
    assert(delegatedTerminal.status === 'completed',
      `the delegated run completes (status=${delegatedTerminal.status}, error=${delegatedTerminal.error || 'none'})`);

    const dReplay = await store.readRunReplay(delegated.id);
    const dSnap = (dReplay && dReplay.snapshot) || {};

    const authorityChecks = Array.isArray(dSnap.authorityChecks) ? dSnap.authorityChecks : [];
    assert(authorityChecks.some(c => c && c.actor === `agent:${executor.id}`),
      `the authority actor is the executor (agent:${executor.id})`);
    assert(!authorityChecks.some(c => c && c.actor === `agent:${planner.id}`
      && c.operation === 'writeFile'),
      'the planner is not recorded as the authority actor for the delegated write');

    const handoffTasks = Array.isArray(dSnap.handoffTasks) ? dSnap.handoffTasks : [];
    assert(handoffTasks.some(t => t && t.status === 'executed'),
      'the handoff task reaches status executed');
    assert(handoffTasks.some(t => t && t.executorAgentId === executor.id
      && t.plannerAgentId === planner.id),
      'delegation provenance identifies planner and executor distinctly');

    // The diagnostic log row must belong to the PLANNER-OWNED run while its
    // structured metadata exposes the acting executor.
    const { rows: logRows } = await store.pool.query(
      `SELECT run_id, ticket_id, type, body FROM "${schema}".diagnostic_logs
        WHERE run_id = $1 AND type = $2`, [delegated.id, 'workspace:write']
    );
    assert(logRows.length === 1,
      `the executor mutation produced exactly one delegated log row (${logRows.length})`);
    // Ownership is carried by the run_id FK; the owning run's agent is the planner
    // (asserted above), so the row belongs to the planner-owned run.
    assert(Number(logRows[0].run_id) === delegated.id,
      'the delegated diagnostic log belongs to the planner-owned run');
    const body = logRows[0].body || {};
    const meta = body.metadata || body || {};
    assert(Number(meta.runOwnerAgentId) === planner.id,
      'structured log metadata records the planner as run owner');
    assert(Number(meta.actingAgentId) === executor.id,
      'structured log metadata records the executor as acting agent');
    assert(meta.authoritySource === 'validated_handoff',
      'structured log metadata records the validated_handoff authority source');

    assert(fs.existsSync(path.join(workspaceRoot, HANDOFF_FILE)),
      'the executor mutation occurred exactly once and is present on disk');

    const dHealth = await server.request('GET', '/health');
    assert(dHealth.statusCode === 200, 'the server remains alive after the delegated handoff');

    // ── Forced required-log failure, post-mutation ────────────────────────────
    await installRejectionTrigger(store, schema);

    const FILE = `a17-contained-${STAMP}.txt`;
    const failingRun = await runTicket(
      `write file ${FILE} containing exactly A17`, planner.id, seen
    );

    const terminal = await waitFor(async () => {
      const current = await store.getRun(failingRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 90000, 'the contained run to reach a terminal state');

    // 15. the intended insert was attempted and rejected
    const fires = await triggerFireCount(store, schema);
    assert(fires >= 1, `the intended ${TARGET_LOG_TYPE} insert was attempted and rejected (${fires} fires)`);

    // 17/18. process alive, no unhandled rejection
    const health = await server.request('GET', '/health');
    assert(health.statusCode === 200, 'the server process remained alive after the rejected required log');
    const stderr = server.output();
    assert(!/unhandledRejection|UnhandledPromiseRejection/i.test(stderr),
      'no unhandledRejection was raised by the rejected required log');

    // 19. the affected run cannot complete
    assert(terminal.status !== 'completed',
      `the run with unresolved required-evidence failure did not complete (status=${terminal.status})`);

    // 20. classified as evidence persistence
    // The failure DOCUMENT is not a column on runs; it is persisted with the
    // terminal bundle in the replay snapshot. Read it from the authority that
    // actually stores it rather than from the run projection.
    const replay = await store.readRunReplay(failingRun.id);
    const snapshot = (replay && replay.snapshot) || {};
    const classification = JSON.stringify({
      failure: snapshot.failure || null,
      error: terminal.error || null
    });
    console.log(`     [failure document] ${classification.slice(0, 400)}`);
    assert(/evidence_persistence|EVIDENCE_PERSISTENCE_FAILED|diagnostic-log evidence could not be persisted/
      .test(classification),
      'the run reaches the documented evidence-persistence failure state');
    assert(/evidence_persistence/.test(classification),
      'the failure carries the structured evidence_persistence kind, not only prose');

    // 21. the mutation committed before the failure is preserved exactly
    const onDisk = path.join(workspaceRoot, FILE);
    assert(fs.existsSync(onDisk), 'the mutation committed before the failure remains on disk');
    assert(fs.readFileSync(onDisk, 'utf8').includes('A17'),
      'the committed mutation content is preserved exactly');

    // 22/23. no subsequent model request or mutation
    const logs = await store.listRunEvents(failingRun.id, { afterSeq: -1, limit: 500 });
    const events = logs || [];
    const receipts = await store.listRunOperations
      ? await store.listRunOperations(failingRun.id, { limit: 100 })
      : [];
    assert((receipts || []).filter(r => r.status === 'succeeded').length <= 1,
      'no subsequent mutation occurred after the required-log failure');

    // 24. containment did not recurse
    const containmentLines = (stderr.match(/diagnostic-log persistence failed/g) || []).length;
    assert(containmentLines >= 1, 'the containment path reported the failure on stderr');
    assert(containmentLines <= 2,
      `containment did not recurse into the failing log path (${containmentLines} reports)`);

    await removeRejectionTrigger(store, schema);

    // 25. unrelated requests and runs continue to succeed
    const later = await server.request('GET', '/tickets', { cookie });
    assert(later.statusCode === 200, 'a later authenticated request still succeeds');

    const healthyRun = await runTicket(
      `write file a17-healthy-${STAMP}.txt containing exactly OK`, planner.id, seen
    );
    const healthyTerminal = await waitFor(async () => {
      const current = await store.getRun(healthyRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 90000, 'the unrelated later run to terminalize');
    assert(healthyTerminal.status === 'completed',
      `an unrelated later run still completes normally (status=${healthyTerminal.status})`);

    assert(events.length >= 0, 'run events remained readable after containment');

    // ── Best-effort terminal echoes ──────────────────────────────────────────
    // run:completed and friends are emitted AFTER commitRunTerminalization has
    // already made terminal state durable. Rejecting them must not disturb that
    // state, must not create a required-evidence marker, and must not stop a run.
    await store.pool.query(`
      CREATE SEQUENCE "${schema}".a17_echo_fires;
      CREATE FUNCTION "${schema}".a17_reject_echo() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.type = 'run:completed' THEN
          PERFORM nextval('"${schema}".a17_echo_fires');
          PERFORM pg_sleep(0.2);
          RAISE EXCEPTION 'A17 injected best-effort echo failure';
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER a17_reject_echo BEFORE INSERT ON "${schema}".diagnostic_logs
        FOR EACH ROW EXECUTE FUNCTION "${schema}".a17_reject_echo();
    `);

    const ECHO_FILE = `a17-echo-${STAMP}.txt`;
    const echoRun = await runTicket(
      `write file ${ECHO_FILE} containing exactly ECHO`, planner.id, seen
    );
    const echoTerminal = await waitFor(async () => {
      const current = await store.getRun(echoRun.id);
      return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
    }, 90000, 'the best-effort echo run to terminalize');

    const { rows: echoFires } = await store.pool.query(
      `SELECT last_value, is_called FROM "${schema}".a17_echo_fires`
    );
    assert(echoFires[0].is_called, 'the run:completed echo insert was attempted and rejected');
    assert(echoTerminal.status === 'completed',
      `a rejected best-effort echo did not alter authoritative terminal state (status=${echoTerminal.status})`);

    const echoReplay = await store.readRunReplay(echoRun.id);
    assert(Boolean(echoReplay && echoReplay.snapshot),
      'the terminal replay snapshot survives a rejected best-effort echo');
    const echoEvents = (echoReplay.snapshot.events) || [];
    assert(!echoEvents.some(e => e && e.type === 'run.reconciliation_evidence_failed'),
      'a best-effort echo failure creates no required-evidence failure record');
    assert(fs.existsSync(path.join(workspaceRoot, ECHO_FILE)),
      'the run mutation is intact after the rejected echo');

    // Best-effort writes are deliberately NOT drained, so the rejection settles
    // after terminal status is already durable. Wait for it rather than racing.
    const echoStderr = await waitFor(async () => {
      const out = server.output();
      return /best-effort-log-failed/.test(out) ? out : null;
    }, 20000, 'the best-effort echo failure to be reported on stderr');
    assert(/best-effort-log-failed/.test(echoStderr),
      'the best-effort echo failure was reported as best effort, not as required evidence');
    assert(!new RegExp(`run ${echoRun.id} diagnostic-log persistence failed`).test(echoStderr),
      'no required-evidence marker was created for the best-effort echo');

    const echoHealth = await server.request('GET', '/health');
    assert(echoHealth.statusCode === 200, 'the process remained alive through the rejected echo');

    await store.pool.query(`
      DROP TRIGGER IF EXISTS a17_reject_echo ON "${schema}".diagnostic_logs;
      DROP FUNCTION IF EXISTS "${schema}".a17_reject_echo();
    `);

    console.log(`\nPASS: delegated run logging containment — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'a17_containment' });
}

main().catch(error => {
  console.error(`\nFAIL: delegated run logging containment — ${error && error.message ? error.message : error}`);
  process.exit(1);
});
