#!/usr/bin/env node
'use strict';
// Configurable runtime limits — JSON API contract, PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, unchanged from the JSON-era original: runtime limits are
// permissioned, validated, optimistically versioned, audited, inherited from
// deployment defaults when unset, and — once a run starts — IMMUTABLE for that run.
// A mid-run policy change must not retroactively re-bound a run already in flight.
//
// Repaired, not rewritten. The assertions are the original ones. What changed is
// where state comes from and where it is read back:
//
//   * the non-admin principal used to prove the 403 paths is created through the
//     store's access APIs instead of a seeded users/groups/memberships JSON trio
//   * `readJson('runtime-limits.json')` becomes `store.getRuntimeLimitsConfig()`
//   * `readJson('runs.json' | 'tickets.json' | 'logs.json')` becomes store reads
//   * the run's replay snapshot is read with `readRunReplay` rather than by
//     following a `replaySnapshotPath` into DATA_DIR
//   * `events.jsonl` string matching becomes a structural read of the event journal
//
// That last substitution is a strengthening, not a translation: the original
// asserted the audit event by substring-matching a JSONL file, which would pass on
// any event that merely CONTAINED the words. The journal read checks the actual
// payload of the actual `runtime_limits.updated` event.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const LIMIT_KEYS = ['maxExecutionSteps', 'maxModelRequestsPerRun', 'maxWorkspaceOperationsPerRun', 'maxRuntimeDurationMs'];
const DEPLOYMENT = {
  maxExecutionSteps: 20,
  maxModelRequestsPerRun: 20,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 20000
};
const VIEWER_PASSWORD = 'viewer-password-runtime-limits';

const assert = createAsserter();

function assertLimits(actual, expected, label) {
  for (const key of LIMIT_KEYS) {
    assert(actual[key] === expected[key], `${label}: ${key} is ${expected[key]} (got ${actual[key]})`);
  }
}

// Slow enough that the suite can observe a run mid-flight and change policy under it.
function createPreload() {
  const file = path.join(os.tmpdir(), `runtime-limits-config-preload-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(file, `
global.fetch = async function() {
  await new Promise(resolve => setTimeout(resolve, 350));
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'runtime-limits-config-test']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({ message: 'done', actions: [], complete: true }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`);
  return file;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preload = createPreload();
  try {
    await withHarness('runtime limits config', async ({ store, startServer }) => {
      // ── Principals ─────────────────────────────────────────────────────────
      // A real non-admin user, created through the store's access APIs. The JSON-era
      // suite seeded this by copying the admin's password hash into a second
      // users.json row; here the viewer gets its own credential and its own group.
      const viewerGroup = (await store.createGroup({
        value: { name: `Viewers-${STAMP}`, permissions: ['ticket:read'], canReceiveTickets: false },
        changedBy: 'runtime-limits-config-test'
      })).group;
      await store.createUser({
        value: { username: 'viewer', passwordHash: await argon2.hash(VIEWER_PASSWORD) },
        groupIds: [viewerGroup.id],
        changedBy: 'runtime-limits-config-test'
      });

      const agent = (await store.createConfiguredAgent({
        value: { name: `RuntimeLimitsAgent-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-runtime-limits-key' },
        groupIds: [], changedBy: 'runtime-limits-config-test'
      })).agent;

      const server = await startServer({
        NODE_OPTIONS: `--require ${preload}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '25',
        AGENT_MAX_EXECUTION_STEPS: String(DEPLOYMENT.maxExecutionSteps),
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: String(DEPLOYMENT.maxModelRequestsPerRun),
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: String(DEPLOYMENT.maxWorkspaceOperationsPerRun),
        AGENT_MAX_RUNTIME_DURATION_MS: String(DEPLOYMENT.maxRuntimeDurationMs),
        MAX_ACTIVE_RUNS: '16',
        MAX_ACTIVE_RUNS_CAP: '64',
        LOCAL_MODEL_CONCURRENCY: '4',
        MAX_LOCAL_MODEL_CONCURRENCY: '8'
      });
      const admin = await server.login();
      const viewer = await server.login('viewer', VIEWER_PASSWORD);

      const json = response => { try { return JSON.parse(response.body); } catch (_) { return null; } };
      const storedConfig = () => store.getRuntimeLimitsConfig();

      async function updateRuntimeLimits(cookie, body, expectedRevision = null) {
        let revision = expectedRevision;
        if (revision === null) {
          const current = await server.request('GET', '/api/runtime-limits', { cookie });
          if (current.statusCode !== 200) throw new Error(`runtime limits GET failed: ${current.statusCode}`);
          revision = json(current).config.revision;
        }
        return server.request('POST', '/api/runtime-limits', {
          cookie, body: { ...body, expectedRevision: revision }
        });
      }

      // ── Authorization ──────────────────────────────────────────────────────
      assert((await server.request('GET', '/api/runtime-limits', { cookie: viewer })).statusCode === 403,
        'a non-admin cannot read runtime limits');
      assert((await server.request('POST', '/api/runtime-limits', { cookie: viewer, body: { maxExecutionSteps: 1 } })).statusCode === 403,
        'a non-admin cannot update runtime limits');

      // ── Inheritance ────────────────────────────────────────────────────────
      const inherited = await server.request('GET', '/api/runtime-limits', { cookie: admin });
      assert(inherited.statusCode === 200, 'an authorized read succeeds');
      assertLimits(json(inherited).effectiveLimits, DEPLOYMENT, 'unset config inherits deployment defaults');
      assert(LIMIT_KEYS.every(key => json(inherited).config[key] === null),
        'an unset config materializes as all-null rather than as absent');
      assert(json(inherited).config.revision === 1, 'the config starts at revision 1');

      const allNull = Object.fromEntries(LIMIT_KEYS.map(key => [key, null]));
      const nullUpdate = await updateRuntimeLimits(admin, allNull);
      assert(nullUpdate.statusCode === 200, 'an explicit all-null config is accepted');
      assertLimits(json(nullUpdate).effectiveLimits, DEPLOYMENT, 'an all-null config still inherits deployment defaults');

      // ── Validation ─────────────────────────────────────────────────────────
      for (const body of [
        { maxExecutionSteps: 0 },
        { maxExecutionSteps: -1 },
        { maxExecutionSteps: 1.5 },
        { maxExecutionSteps: '2' },
        { maxRuntimeDurationMs: 4999 }
      ]) {
        const response = await updateRuntimeLimits(admin, body);
        assert(response.statusCode === 400, `invalid limit rejected: ${JSON.stringify(body)}`);
      }

      // ── Persistence ────────────────────────────────────────────────────────
      const configured = {
        maxExecutionSteps: 3,
        maxModelRequestsPerRun: 3,
        maxWorkspaceOperationsPerRun: 10,
        maxRuntimeDurationMs: 5000
      };
      const valid = await updateRuntimeLimits(admin, configured);
      assert(valid.statusCode === 200, `a valid config is accepted (${valid.body})`);
      assertLimits(json(valid).effectiveLimits, configured, 'configured values become effective');
      assertLimits(await storedConfig(), configured, 'configured values are persisted to the store');
      const audited = await storedConfig();
      assert(audited.updatedBy === 'admin' && typeof audited.updatedAt === 'string',
        'the persisted config carries audit metadata');

      // ── Optimistic concurrency ─────────────────────────────────────────────
      const staleRevision = json(await server.request('GET', '/api/runtime-limits', { cookie: admin })).config.revision;
      const advanced = await updateRuntimeLimits(admin, { maxExecutionSteps: 4 }, staleRevision);
      assert(advanced.statusCode === 200 && json(advanced).config.revision === staleRevision + 1,
        'a successful update advances the config revision');
      const stale = await updateRuntimeLimits(admin, { maxExecutionSteps: 5 }, staleRevision);
      assert(stale.statusCode === 409, 'an update against a stale revision is rejected');
      assert((await storedConfig()).maxExecutionSteps === 4,
        'a rejected stale update does not overwrite current policy');

      // ── System keys round-trip ─────────────────────────────────────────────
      // Regression: the validator once returned only pickRuntimeLimitValues(),
      // silently dropping localModelConcurrency so the setting persisted as null and
      // was inert. The ceiling (MAX_LOCAL_MODEL_CONCURRENCY=8) is decoupled from the
      // inherited default (LOCAL_MODEL_CONCURRENCY=4), so raising above the default
      // up to the ceiling must be allowed.
      for (const body of [
        { localModelConcurrency: 0 }, { localModelConcurrency: -1 },
        { localModelConcurrency: 1.5 }, { localModelConcurrency: '2' },
        { localModelConcurrency: 9 }
      ]) {
        assert((await updateRuntimeLimits(admin, body)).statusCode === 400,
          `invalid localModelConcurrency rejected: ${JSON.stringify(body)}`);
      }
      const concurrency = await updateRuntimeLimits(admin, { localModelConcurrency: 6 });
      assert(concurrency.statusCode === 200, `localModelConcurrency above the default is accepted (${concurrency.body})`);
      assert(json(concurrency).config.localModelConcurrency === 6, 'the response echoes the stored concurrency');
      assert((await storedConfig()).localModelConcurrency === 6, 'localModelConcurrency is persisted');

      for (const body of [
        { maxActiveRuns: 0 }, { maxActiveRuns: -1 },
        { maxActiveRuns: 1.5 }, { maxActiveRuns: '2' }, { maxActiveRuns: 65 }
      ]) {
        assert((await updateRuntimeLimits(admin, body)).statusCode === 400,
          `invalid maxActiveRuns rejected: ${JSON.stringify(body)}`);
      }
      const activeRuns = await updateRuntimeLimits(admin, { maxActiveRuns: 24 });
      assert(activeRuns.statusCode === 200, `a valid maxActiveRuns is accepted (${activeRuns.body})`);
      assert(json(activeRuns).config.maxActiveRuns === 24, 'the response echoes the stored run admission cap');
      assert((await storedConfig()).maxActiveRuns === 24, 'maxActiveRuns is persisted');

      const status = await server.request('GET', '/api/runtime/status', { cookie: admin });
      assert(status.statusCode === 200, `runtime status is readable (${status.body})`);
      // Field names re-pointed at the live shape: the JSON-era suite read
      // `concurrencyLimits.process` and `concurrencyLimits.activeProcessRuns`, which
      // no longer exist. The status payload now distinguishes the DEPLOYMENT-scoped
      // cap from this PROCESS's occupancy, so both are asserted.
      assert(json(status).concurrencyLimits.maxActiveRuns === 24,
        'runtime status exposes the effective process-wide concurrency cap');
      assert(json(status).concurrencyLimits.localModelConcurrency === 6,
        'runtime status exposes the effective local-model concurrency');
      assert(Number.isInteger(json(status).concurrencyLimits.localProcess.admittedRuns),
        'runtime status exposes this process\'s admitted run slots');

      // A limit-only update that omits the system keys must not wipe them.
      // (Re-applying `configured` also restores the state the run assertions expect.)
      assert((await updateRuntimeLimits(admin, configured)).statusCode === 200, 'a limit-only update succeeds');
      const afterLimitOnly = await storedConfig();
      assert(afterLimitOnly.localModelConcurrency === 6, 'localModelConcurrency survives an unrelated update');
      assert(afterLimitOnly.maxActiveRuns === 24, 'maxActiveRuns survives an unrelated update');
      assertLimits(afterLimitOnly, configured, 'a limit-only update preserves the configured limits');

      // ── Per-run immutability ───────────────────────────────────────────────
      const objective = `Create a runtime snapshot ${STAMP}`;
      const created = await server.request('POST', '/tickets', {
        cookie: admin,
        form: {
          objective, assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id), assignmentMode: 'individual'
        }
      });
      assert(created.statusCode === 302, `ticket create redirected (HTTP ${created.statusCode})`);

      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 200 });
        return tickets.find(t => t.objective === objective) || null;
      }, 30000, 'ticket persistence');
      const run = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
        return runs[0] || null;
      }, 30000, 'run dispatch');

      assertLimits(run.runtimeLimitsSnapshot, configured, 'the new run snapshots the configured limits');
      assert(run.runtimeLimitsSnapshot.source.uiConfigured === true,
        'the run snapshot identifies the limits as UI-configured');

      // Change policy while the run is in flight. The stub sleeps 350ms per call, so
      // the update lands mid-run rather than after terminalization.
      await waitFor(async () => {
        const logs = await store.listLogs({ runId: run.id, types: ['model:request'], limit: 5 });
        return (logs.logs || logs).length > 0 ? true : null;
      }, 30000, 'the run to reach its first model request');
      const lowered = { ...configured, maxExecutionSteps: 1, maxModelRequestsPerRun: 1, maxWorkspaceOperationsPerRun: 1 };
      assert((await updateRuntimeLimits(admin, lowered)).statusCode === 200,
        'policy may be changed while a run is in flight (for future runs)');

      const terminal = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && ['completed', 'failed'].includes(current.status) ? current : null;
      }, 60000, 'the in-flight run to terminalize');
      assertLimits(terminal.runtimeLimitsSnapshot, configured,
        'the in-flight run keeps its run-start limits after the policy change');

      const replay = (await store.readRunReplay(terminal.id)).snapshot;
      assertLimits(replay.runtimeLimitsSnapshot, configured, 'the replay snapshot records the run-start limits');
      assert(replay.runtimeEnvelope.maxExecutionSteps === configured.maxExecutionSteps,
        'the runtime envelope the model saw used the run-start limits');

      // ── Workload profile caps ──────────────────────────────────────────────
      const profileConfig = {
        maxExecutionSteps: 15,
        maxModelRequestsPerRun: 15,
        maxWorkspaceOperationsPerRun: 30,
        maxRuntimeDurationMs: 10000
      };
      assert((await updateRuntimeLimits(admin, profileConfig)).statusCode === 200, 'the profile config update succeeds');
      const reportObjective = `Write report-summary-${STAMP}.txt with a report summary`;
      const reportCreated = await server.request('POST', '/tickets', {
        cookie: admin,
        form: {
          objective: reportObjective, assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id), assignmentMode: 'individual'
        }
      });
      assert(reportCreated.statusCode === 302, 'the report ticket was created');
      const reportTicket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 200 });
        return tickets.find(t => t.objective === reportObjective) || null;
      }, 30000, 'report ticket persistence');
      const reportRun = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: reportTicket.id, limit: 10 });
        return runs[0] || null;
      }, 30000, 'report run dispatch');

      assert(reportRun.runtimeLimitsSnapshot.maxExecutionSteps === 12,
        'the report profile caps execution steps below the configured value');
      assert(reportRun.runtimeLimitsSnapshot.maxModelRequestsPerRun === 8,
        'the report profile caps model requests below the configured value');
      assert(reportRun.runtimeLimitsSnapshot.maxListDirectoryPerRun === 3,
        'the report profile listDirectory cap is snapshotted');
      assert(reportRun.runtimeLimitsSnapshot.maxReadFilePerRun === 8,
        'the report profile readFile cap is snapshotted');

      // ── Audit trail ────────────────────────────────────────────────────────
      // Read the journal structurally. The JSON-era suite substring-matched
      // events.jsonl, which would have accepted any event merely containing these
      // words anywhere in the file.
      const journal = await waitFor(async () => {
        const entries = await store.listEventJournal({ typePrefix: 'runtime_limits.updated', limit: 100 });
        const rows = entries.events || entries;
        return rows.length > 0 ? rows : null;
      }, 30000, 'the runtime_limits.updated audit event');

      const audit = journal[journal.length - 1];
      const auditPayload = audit.payload || audit;
      assert(audit.type === 'runtime_limits.updated', 'the audit event carries the runtime-limits type');
      assert(auditPayload.actor === 'admin', 'the audit event names the acting operator');
      assert(auditPayload.oldValues && auditPayload.newValues,
        'the audit event records both the previous and the new values');
      assert('maxActiveRuns' in auditPayload.newValues,
        'the audit event covers the process-wide concurrency policy, not only the per-run limits');
      assert(Object.prototype.hasOwnProperty.call(auditPayload, 'revision'),
        'the audit event records the revision it advanced to');

      const operatorLogs = await store.listLogs({ types: ['runtime_limits.updated'], limit: 50 });
      const logRows = operatorLogs.logs || operatorLogs;
      const operatorEntry = logRows.find(entry => entry.actor === 'admin');
      assert(Boolean(operatorEntry),
        'the operator log records the runtime-limits change and its actor');
      assert(Boolean(operatorEntry.oldValues) && Boolean(operatorEntry.newValues),
        'the operator log carries the same before/after values as the journal event');

      console.log(`\nPASS: configurable runtime limits — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'runtime_limits_config' });
  } finally {
    try { fs.unlinkSync(preload); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: configurable runtime limits — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
