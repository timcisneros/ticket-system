#!/usr/bin/env node
'use strict';

// P6-S3 owning PostgreSQL-native suite (docs/ARCHITECTURAL_DECISIONS_PENDING.md
// P6 design freeze; docs/DEPLOYMENT_CONTRACT.md §2/§4/§6/§9/§13).
//
// Deterministic PROCESS-level hosted-recovery evidence for the frozen
// single-host multi-process topology: REAL independent server processes
// against one real PostgreSQL authority. Contents, and why they sit here —
//
//   MULTIPROCESS-A / no leader: two full application processes race for one
//     pending run; exactly one authoritative claim survives; deterministic
//     alternation (freeze/continue on real processes) proves BOTH processes
//     claim through PostgreSQL rows; the deployment-wide active-run seat
//     excludes the peer WITHOUT making an otherwise-healthy process unready
//     (capacity ≠ readiness); the shared evidence chain stays valid.
//   CRASH-A + LEASE-A: SIGKILL a process holding a live Run lease. The
//     authoritative row stays honestly stale (no fabricated completion, no
//     forged evidence); no takeover happens while the dead lease is still
//     valid; takeover happens at/after canonical lease expiry, by the real
//     surviving peer, and continues the SAME Run and SAME Ticket attempt.
//   RESTART-A: total process death + cold restart reconstructs from
//     PostgreSQL (startup recovery, mode `process_restart`), settles the run
//     truthfully ONCE, is idempotent on a second restart, and creates NO new
//     attempt (recovery is not retry/rerun).
//   PG-OUTAGE-A: a real full connection-plane outage (idle AND in-flight
//     connections severed behind a suite-owned proxy in front of the real
//     PostgreSQL port) fails closed with the designed readiness projection
//     while liveness keeps answering; refused mutations leave no durable
//     state; readiness restores per request without restart.
//   EVIDENCE-LATCH-A (process-level): a real evidence-write failure — produced
//     through a real PostgreSQL boundary — latches one process (degraded
//     health, designed fatal refusal code, claimer stops); the peer process
//     stays healthy and ready; the latched process recovers only by the
//     documented operator restart, after which claiming resumes normally.
//   MIGRATION-MISMATCH-A: incompatible ledger states refuse SERVER STARTUP
//     (not only runtime readiness), name the incompatibility, apply nothing;
//     a fully-current boot is a mutation-free no-op.
//   DRAIN-A: a mid-flight run under SIGTERM settles truthfully or stays
//     honestly recoverable; the exit code is the declared drain code; the
//     stopped surface accepts no further work; the forced-stop path keeps the
//     run stale rather than fabricating completion.
//   HOST-LOCAL-A: both processes write into ONE host-local workspace effect
//     root; nothing claims shared storage or multi-host execution.
//
// Companion owners are NOT duplicated: in-flight provider-request uncertainty
// and conservative settlement are owned by
// governed-post-transport-restart-postgres-test.js (and siblings); the live
// runtime readiness/migration-status/capacity-per-request contract and doctor
// ledger states are owned by p6-s2-readiness-postgres-test.js; the
// backpressure-vs-latched refusal wording is owned by
// mutation-admission-backpressure-test.js; the drain mechanics are owned by
// run-evidence-drain-test.js; store-level claim mutual exclusion is owned by
// concurrency-conflict-test.js.
//
// T10 migration posture is preserved by construction: this suite runs ONLY
// inside a disposable harness schema created under the explicit
// disposable-migration contract; the operational database and the migration
// execution authorization record are never contacted, and migration 044
// remains `NOT_AUTHORIZED` / operationally unapplied.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { withHarness, freePort, sleep } = require('./postgres-test-harness');
const { PostgresRuntimeStore, migrationChecksum, migrationFiles } = require('../persistence/postgres/store');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

const STAMP = `p6s3${Date.now()}`;
let scenariosRun = 0;
let assertionCount = 0;
function bump() { assertionCount += 1; }
function ok(value, message) { bump(); assert.ok(value, message); }
function okEqual(actual, expected, message) { bump(); assert.strictEqual(actual, expected, message); }
function okMatch(value, regexp, message) { bump(); assert.match(String(value), regexp, message); }
function scenario(label) { scenariosRun += 1; console.log(`  ok ${label}`); }

function rawHealthProbe(port) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── The outage seam: a suite-owned accept proxy in front of the REAL ────────
// PostgreSQL port. Outage-stage server processes put their DATABASE_URL
// through the proxy; the suite's observation store bypasses it. cut() severs
// every live connection and refuses new ones — a full real outage from the
// child's perspective (idle pool clients die AND in-flight queries die).
// openUp() restores forward transit without restarting PostgreSQL. No
// production flag, no mutation, no second database cluster.
function createPostgresConnectionProxy(targetPort) {
  const sockets = new Set();
  let open = true;
  const server = net.createServer(client => {
    if (!open) { client.destroy(); return; }
    const upstream = net.connect(targetPort, '127.0.0.1');
    const cleanup = () => { sockets.delete(client); sockets.delete(upstream); };
    sockets.add(client); sockets.add(upstream);
    const fail = () => {
      try { client.destroy(); } catch (_) {}
      try { upstream.destroy(); } catch (_) {}
      cleanup();
    };
    client.on('data', chunk => { try { upstream.write(chunk); } catch (_) { fail(); } });
    upstream.on('data', chunk => { try { client.write(chunk); } catch (_) { fail(); } });
    client.on('error', fail);
    upstream.on('error', fail);
    client.on('close', () => { try { upstream.destroy(); } catch (_) {} cleanup(); });
    upstream.on('close', () => { try { client.destroy(); } catch (_) {} cleanup(); });
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    cut() { open = false; for (const socket of sockets) { try { socket.destroy(); } catch (_) {} } sockets.clear(); },
    openUp() { open = true; },
    close() {
      open = false;
      for (const socket of sockets) { try { socket.destroy(); } catch (_) {} }
      sockets.clear();
      return new Promise(resolve => server.close(resolve));
    }
  };
}

// Direct child spawn for MIGRATION refusal scenarios: the refusal shape
// asserts the exit path itself; the harness readiness wrapper (which kills a
// child on timed-out readiness) would blur that evidence.
function spawnServerChild({ port, databaseUrl, schema, workspaceRoot, extraEnv = {} }) {
  const childEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    POSTGRES_SCHEMA: schema,
    WORKSPACE_ROOT: workspaceRoot,
    SESSION_SECRET: 'p6-s3-hosted-recovery-secret-0123456789abcdef0123456789abcdef',
    // The same credentials the harness servers authenticate with, so a
    // booting process and the harness share ONE admin identity.
    ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
    PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000',
    ...extraEnv
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { output: '' };
  child.stdout.on('data', chunk => { state.output += String(chunk); });
  child.stderr.on('data', chunk => { state.output += String(chunk); });
  return { child, state };
}

// Boot a child until it either REFUSES (process exit) or becomes READY
// (positive control); returns exit facts with the full output.
async function probeServerBoot({ databaseUrl, schema, workspaceRoot, readyTimeoutMs = 45000, holdMs = 400 }) {
  const port = await freePort();
  const spawned = spawnServerChild({ port, databaseUrl, schema, workspaceRoot });
  // Attach BEFORE anything else: a refusing child can exit within milliseconds.
  const exitPromise = new Promise(resolve => {
    spawned.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    const probe = await rawHealthProbe(port);
    if (probe && probe.statusCode === 200) {
      try { if (JSON.parse(probe.body).ready) { ready = true; break; } } catch (_) { /* still booting */ }
    }
    if (spawned.child.exitCode !== null) break;
    await sleep(200);
  }
  const exitInfo = { ready, port };
  if (ready) {
    // A successful control boot: keep the exit observable, then stop.
    await sleep(holdMs);
    spawned.child.kill('SIGTERM');
  } else {
    // Refusal scenarios resolve through the pre-attached exit; any other
    // never-ready state is force-stopped.
    if (spawned.child.exitCode === null) spawned.child.kill('SIGKILL');
  }
  const stopped = await Promise.race([
    exitPromise.then(result => ({ ...result, timedOut: false })),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 10000))
  ]);
  exitInfo.didExit = !stopped.timedOut;
  exitInfo.code = stopped.code === undefined ? spawned.child.exitCode : stopped.code;
  exitInfo.output = spawned.state.output;
  return exitInfo;
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FAIL: p6-s3 hosted recovery suite requires TEST_DATABASE_URL (or DATABASE_URL).');
    process.exit(1);
  }
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p6s3-ws-'));
  const refusalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'p6s3-boot-ws-'));
  let proxy = null;

  try {
    await withHarness('p6 s3 hosted recovery', async ({ store, schema, startServer, workspaceRoot }) => {
      // The stored migration-identity versions are the canonical file names.
      const versionsList = await migrationFiles();
      const headVersion = versionsList[versionsList.length - 1];

      const agent = (await store.createConfiguredAgent({
        value: { name: `p6s3-agent-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'p6-s3-test-only' },
        groupIds: [], changedBy: 'p6-s3-hosted-recovery-postgres-test'
      })).agent;

      const baseEnv = {
        RUNTIME_SCHEDULER_INTERVAL_MS: '120',
        RUN_LEASE_DURATION_MS: '8000',
        SHUTDOWN_RUN_DRAIN_TIMEOUT_MS: '4000'
      };

      let workflowSeq = 0;
      async function createWriteWorkflow() {
        workflowSeq += 1;
        const workflowId = `p6s3wf${STAMP}${workflowSeq}`;
        const firstPath = `p6s3-run-${STAMP}-${workflowSeq}.txt`;
        await store.createWorkflow({
          value: {
            id: workflowId, name: `p6s3 write ${workflowSeq}`, version: '1', enabled: true, inputSchema: {},
            actions: [
              { id: 'write', action: 'writeFile', input: { path: firstPath, content: 'x' }, next: 'write2' },
              { id: 'write2', action: 'writeFile', input: { path: `p6s3-run-${STAMP}-${workflowSeq}b.txt`, content: 'y' }, next: 'done' },
              { id: 'done', action: 'stop', input: { result: {} } }
            ],
            postconditions: [{ id: 'pc', type: 'fileContains', path: firstPath, contains: 'x' }],
            verifierContract: null
          },
          changedBy: 'p6-s3-hosted-recovery-postgres-test'
        });
        return { workflowId, firstPath };
      }

      async function loginCookie(server) {
        let response = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          response = await server.request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
          if (response.statusCode === 302) break;
          await sleep(200);
        }
        bump();
        assert.ok(response.statusCode === 302, `login admitted (HTTP ${response.statusCode})`);
        const raw = response.headers['set-cookie'] || [];
        return (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(c => c.split(';')[0]).join('; ');
      }

      const createTicket = async (objective, workflowId, via) => {
        const server = via;
        ok(Boolean(server), 'a live server exists to create work');
        const cookie = await loginCookie(server);
        const response = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective, capabilityType: 'workflow', workflowId, workflowInput: '{}',
            assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
          }
        });
        bump();
        assert.ok(response.statusCode === 302 || response.statusCode === 200, `POST /tickets admitted (HTTP ${response.statusCode})`);
      };

      const latestRun = async () => (await store.pool.query(
        `SELECT id, ticket_id, status, lease_owner, lease_expires_at, ticket_attempt_id
           FROM ${store.table('runs')} ORDER BY id DESC LIMIT 1`
      )).rows[0];
      const runsPage = async () => (await store.pool.query(
        `SELECT id, ticket_id, status, lease_owner, lease_expires_at, ticket_attempt_id
           FROM ${store.table('runs')} ORDER BY id`
      )).rows;
      const eventsOf = async runId => (await store.pool.query(
        `SELECT seq, type, payload FROM ${store.table('events')} WHERE run_id = $1 ORDER BY seq`, [runId]
      )).rows.map(event => ({ ...event, payload: event.payload && typeof event.payload === 'object' ? event.payload : {} }));
      const countEvents = async ({ type, runId }) => (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('events')}
          WHERE type = $1 ${runId ? 'AND run_id = $2' : ''}`,
        runId ? [type, runId] : [type])).rows[0].n;
      const chainValid = async runId => {
        const events = [];
        let afterSeq = -1;
        while (true) {
          const page = await store.listRunEvents(runId, { afterSeq, limit: 200 });
          if (!Array.isArray(page) || page.length === 0) break;
          events.push(...page);
          afterSeq = page[page.length - 1].seq;
          if (page.length < 200) break;
        }
        return verifyCurrentRunEventChain(events).chainValid;
      };
      const ownerPid = owner => {
        const match = /^(\d+):/.exec(String(owner || ''));
        return match ? Number(match[1]) : null;
      };
      const waitTerminated = async runId => {
        for (let i = 0; i < 320; i += 1) {
          await sleep(150);
          const row = (await store.pool.query(
            `SELECT id, ticket_id, status, ticket_attempt_id FROM ${store.table('runs')} WHERE id = $1`, [runId])).rows[0];
          if (row && !['pending', 'running'].includes(row.status)) return row;
        }
        return (await store.pool.query(
          `SELECT id, ticket_id, status, ticket_attempt_id FROM ${store.table('runs')} WHERE id = $1`, [runId])).rows[0];
      };

      // ══════════════ 1. MIGRATION-MISMATCH-A: startup refusals ════════════
      const ledgerCount = async () => (await store.pool.query(
        `SELECT count(*)::int AS ledger,
                (SELECT count(*)::int FROM ${store.table('schema_migration_identities')}) AS identities
           FROM ${store.table('schema_migrations')}`
      )).rows[0];
      const bootProbe = () => probeServerBoot({ databaseUrl, schema, workspaceRoot: refusalWorkspace });

      const before = await ledgerCount();
      const healthy = await bootProbe();
      ok(healthy.ready === true, '1a: a fully-current ledger boots a ready server (positive control)');
      const afterHealthy = await ledgerCount();
      okEqual(afterHealthy.ledger, before.ledger, '1a: the no-op boot applied no migration rows');
      okEqual(afterHealthy.identities, before.identities, '1a: the no-op boot wrote no identities');
      scenario('1a: a fully-current ledger boots ready and applies nothing');

      await store.pool.query(`INSERT INTO ${store.table('schema_migrations')} (version) VALUES ($1)`, ['099_not_from_this_repository.sql']);
      const unknownRefusal = await bootProbe();
      ok(unknownRefusal.didExit && unknownRefusal.code !== 0, `1b: an unknown-future ledger refuses startup (exit ${unknownRefusal.code})`);
      okMatch(unknownRefusal.output, /unknown future migration/i, '1b: the refusal names the incompatible ledger state');
      const afterUnknown = await ledgerCount();
      okEqual(afterUnknown.ledger, before.ledger + 1, '1b: the refused boot migrated and dropped NOTHING');
      await store.pool.query(`DELETE FROM ${store.table('schema_migrations')} WHERE version = $1`, ['099_not_from_this_repository.sql']);
      scenario('1b: an unknown future migration refuses startup and mutates nothing');

      await store.pool.query(`ALTER TABLE ${store.table('schema_migration_identities')} DISABLE TRIGGER schema_migration_identities_append_only`);
      try {
        ok((await store.pool.query(
          `SELECT count(*)::int AS n FROM ${store.table('schema_migrations')} WHERE version = $1`, [headVersion])).rows[0].n === 1,
          '1c: the head ledger row exists before the controlled tamper');
        await store.pool.query(`DELETE FROM ${store.table('schema_migration_identities')} WHERE version = $1`, [headVersion]);
        await store.pool.query(`DELETE FROM ${store.table('schema_migrations')} WHERE version = $1`, [headVersion]);
        const pendingRefusal = await bootProbe();
        ok(pendingRefusal.didExit && pendingRefusal.code !== 0, `1c: a behind-ledger refuses startup (exit ${pendingRefusal.code})`);
        okMatch(pendingRefusal.output, /missing required migration/i, '1c: the refusal names the missing migration');
        ok(!/default admin user created/i.test(pendingRefusal.output),
          '1c: the refused start does not treat mismatched state as a first-run bootstrap');
        const afterPending = await ledgerCount();
        okEqual(afterPending.ledger, before.ledger - 1, '1c: the refused boot migrated NOTHING');
        await store.pool.query(`INSERT INTO ${store.table('schema_migrations')} (version) VALUES ($1)`, [headVersion]);
        await store.pool.query(
          `INSERT INTO ${store.table('schema_migration_identities')} (version, sha256) VALUES ($1, $2)`,
          [headVersion, migrationChecksum(headVersion)]);
      } finally {
        await store.pool.query(`ALTER TABLE ${store.table('schema_migration_identities')} ENABLE TRIGGER schema_migration_identities_append_only`);
      }
      scenario('1c: a behind (pending) ledger refuses startup before any mutation');

      await store.pool.query(`ALTER TABLE ${store.table('schema_migration_identities')} DISABLE TRIGGER schema_migration_identities_append_only`);
      try {
        await store.pool.query(
          `UPDATE ${store.table('schema_migration_identities')} SET sha256 = $1 WHERE version = $2`,
          ['0'.repeat(64), headVersion]);
        const driftRefusal = await bootProbe();
        ok(driftRefusal.didExit && driftRefusal.code !== 0, `1d: identity drift refuses startup (exit ${driftRefusal.code})`);
        okMatch(driftRefusal.output, /missing or changed migration identity/i, '1d: the refusal names the identity failure');
        await store.pool.query(
          `UPDATE ${store.table('schema_migration_identities')} SET sha256 = $1 WHERE version = $2`,
          [migrationChecksum(headVersion), headVersion]);
      } finally {
        await store.pool.query(`ALTER TABLE ${store.table('schema_migration_identities')} ENABLE TRIGGER schema_migration_identities_append_only`);
      }
      const afterDrift = await ledgerCount();
      okEqual(afterDrift.ledger, before.ledger, '1d: the restored ledger equals the healthy baseline');
      scenario('1d: drifted migration identities refuse startup; restoration restores boot readiness');

      // ══════════════ 2. MULTIPROCESS-A ════════════════════════════════════
      const deploymentSeat = await store.getRuntimeLimitsConfig();
      const { revision, updatedBy, updatedAt, ...limitsValue } = deploymentSeat;
      await store.updateRuntimeLimitsConfig({
        expectedRevision: revision,
        value: { ...limitsValue, maxActiveRuns: 1 },
        changedBy: 'p6-s3-hosted-recovery-postgres-test'
      });

      const serverA = await startServer({ env: baseEnv });
      const serverB = await startServer({ env: baseEnv });

      // 2a. free competition between two live processes.
      const competitionWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 free competition ${STAMP}`, competitionWorkflow.workflowId, serverA);
      let claimed = null;
      for (let i = 0; i < 140 && !claimed; i += 1) {
        await sleep(50);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) claimed = row;
      }
      ok(claimed, '2a: exactly one of the two live processes claimed the pending run');
      const claimPid = ownerPid(claimed.lease_owner);
      ok(claimPid === serverA.child.pid || claimPid === serverB.child.pid,
        `2a: the claim owner ${claimed.lease_owner} is one of the two real processes (pids ${serverA.child.pid}/${serverB.child.pid})`);
      okEqual(await countEvents({ type: 'run.lease_acquired', runId: claimed.id }), 1,
        '2a: exactly ONE authoritative lease-acquisition event exists for the run');
      scenario('2a: two live processes race for one run — exactly one authoritative claim survives');

      // 2b. seat-bound exclusion: FREEZE THE CLAIMING HOLDER (whichever
      // process it was) immediately after its claim committed; the second run
      // stays pending and the healthy peer stays ready.
      const holderAdvisory = claimPid === serverA.child.pid ? serverA : serverB;
      const blockedPeerProcess = claimPid === serverA.child.pid ? serverB : serverA;
      process.kill(holderAdvisory.child.pid, 'SIGSTOP');
      const seatWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 seat-bound next run ${STAMP}`, seatWorkflow.workflowId, blockedPeerProcess);
      await sleep(1000);
      const seatRows = await runsPage();
      ok(seatRows.length >= 2, '2b: the second run exists');
      okEqual(seatRows[seatRows.length - 1].status, 'pending',
        '2b: the deployment-wide seat keeps the next run unclaimed while the holder is frozen');
      ok((await countEvents({ type: 'capacity.waiting' })) >= 1,
        '2b: the exclusion is recorded through canonical capacity evidence');
      const blockedPeerHealth = await blockedPeerProcess.request('GET', '/health');
      okEqual(blockedPeerHealth.statusCode, 200, '2b: a healthy peer blocked by capacity stays READY');
      const blockedPeerBody = JSON.parse(blockedPeerHealth.body);
      okEqual(blockedPeerBody.alive, true, '2b: liveness unimpaired');
      okEqual(blockedPeerBody.ready, true, '2b: the capacity exclusion is NEVER a readiness failure');
      process.kill(holderAdvisory.child.pid, 'SIGCONT');
      let seatSettled = false;
      for (let i = 0; i < 240 && !seatSettled; i += 1) {
        await sleep(150);
        const rowsNow = await runsPage();
        seatSettled = rowsNow.length >= 2 && rowsNow.every(r => !['pending', 'running'].includes(r.status));
      }
      ok(seatSettled, '2b: unfreezing the holder frees the seat and both runs settle truthfully');
      scenario('2b: the deployment-wide active-run seat excludes the peer without ever marking it unready');

      // 2c. deterministic peer claim with the first process frozen.
      process.kill(serverA.child.pid, 'SIGSTOP');
      const peerWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 peer claim ${STAMP}`, peerWorkflow.workflowId, serverB);
      let peerClaimed = null;
      for (let i = 0; i < 140 && !peerClaimed; i += 1) {
        await sleep(50);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) peerClaimed = row;
      }
      process.kill(serverA.child.pid, 'SIGCONT');
      ok(peerClaimed, '2c: the peer claimed work while the other process was frozen');
      okEqual(ownerPid(peerClaimed.lease_owner), serverB.child.pid,
        '2c: the peer process itself owns the claim — claims come from PostgreSQL rows, never in-memory authority');
      const peerSettled = await waitTerminated(peerClaimed.id);
      ok(!['pending', 'running'].includes(peerSettled.status), '2c: the peer executed its claim to a truthful terminal state');
      scenario('2c: each process claims and executes through PostgreSQL with no leader and no cross-process memory');

      okEqual(await chainValid(claimed.id), true, '2d: the evidence chain remains valid after multi-process competition');
      scenario('2d: multi-process competition leaves the shared evidence chain valid');

      // Restore the deployment-wide seat so the recovery stages exercise
      // recovery (not admission pressure) going forward.
      const finalSeat = await store.getRuntimeLimitsConfig();
      const { revision: finalRevision, updatedBy: finalUpdatedBy, updatedAt: finalUpdatedAt, ...finalValue } = finalSeat;
      await store.updateRuntimeLimitsConfig({
        expectedRevision: finalRevision,
        value: { ...finalValue, maxActiveRuns: 32 },
        changedBy: 'p6-s3-hosted-recovery-postgres-test'
      });

      // ══════════════ 3. CRASH-A / LEASE-A ═════════════════════════════════
      const crashWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 crash victim ${STAMP}`, crashWorkflow.workflowId, serverB);
      let crashClaim = null;
      for (let i = 0; i < 140 && !crashClaim; i += 1) {
        await sleep(50);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) crashClaim = row;
      }
      ok(crashClaim, '3: the crash-victim run is live under a lease');
      const crashHolderPid = ownerPid(crashClaim.lease_owner);
      const holderServer = crashHolderPid === serverA.child.pid ? serverA : serverB;
      const peerServer = crashHolderPid === serverA.child.pid ? serverB : serverA;
      const prekillTerminal = (await eventsOf(crashClaim.id)).filter(event => event.type === 'run.terminalized').length;
      okEqual(prekillTerminal, 0, '3: nothing terminal existed before the crash');

      process.kill(holderServer.child.pid, 'SIGKILL');
      await sleep(400);
      const postKill = await latestRun();
      okEqual(postKill.id, crashClaim.id, '3: the killed process left the authoritative row untouched');
      okEqual(postKill.status, 'running', '3: the run is still RUNNING under its lease — never marked completed by the crash');
      okEqual(postKill.lease_owner, crashClaim.lease_owner, '3: the stale lease still names the dead owner');
      ok(Date.parse(postKill.lease_expires_at) > Date.now(), '3: the dead process lease is nonetheless still valid — not fake-released');
      okEqual(await chainValid(postKill.id), true, '3: the event chain is intact after the kill — no forged evidence');
      scenario('3a: sudden process death leaves authoritative state recoverable and never fabricated');

      let noTakeover = true;
      for (let i = 0; i < 8 && noTakeover; i += 1) {
        await sleep(150);
        const row = await latestRun();
        if (row.id !== crashClaim.id || row.status !== 'running') noTakeover = false;
        if (row.id === crashClaim.id && (await countEvents({ type: 'run.recovery_claimed', runId: crashClaim.id })) !== 0) noTakeover = false;
      }
      ok(noTakeover, '3: NO takeover while the dead process lease was still valid');
      scenario('3b: no premature takeover/redispatch while the lease is canonically valid');

      let recoveryObserved = null;
      for (let i = 0; i < 200 && !recoveryObserved; i += 1) {
        await sleep(150);
        const row = await latestRun();
        if (row && row.id === crashClaim.id) {
          const recovery = (await eventsOf(row.id)).find(event => event.type === 'run.recovery_claimed');
          if (recovery) recoveryObserved = { row, recovery };
        }
      }
      ok(recoveryObserved, '3: a peer took over through the canonical recovery authority');
      const previousLease = recoveryObserved && recoveryObserved.recovery.payload.previousLease;
      okEqual(previousLease.leaseOwner, crashClaim.lease_owner, '3: recovery names the exact dead owner');
      ok(Date.parse(recoveryObserved.recovery.payload.recoveredAt) >= Date.parse(previousLease.leaseExpiresAt) - 20,
        '3: takeover happened at/after the previous lease expiry — never early');
      okEqual(ownerPid(recoveryObserved.recovery.payload.recoveryOwner), peerServer.child.pid,
        '3: the takeover was performed by the real surviving peer');
      scenario('3c: lease takeover happens only after canonical expiry, performed by a real peer');

      const recoveredRow = await waitTerminated(crashClaim.id);
      okEqual(recoveredRow.id, crashClaim.id, '3: the SAME run was recovered (no replacement run)');
      okEqual(recoveredRow.ticket_attempt_id, crashClaim.ticket_attempt_id, '3: the SAME Ticket attempt — recovery is not a retry');
      const attemptRows = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('ticket_attempts')} WHERE ticket_id = $1`,
        [recoveredRow.ticket_id])).rows[0].n;
      okEqual(attemptRows, 1, '3: no duplicate attempt was minted merely because a process died');
      const recoveredEvents = await eventsOf(recoveredRow.id);
      const terminalEvents = recoveredEvents.filter(event => event.type === 'run.terminalized');
      okEqual(terminalEvents.length, 1, '3: exactly one truthful terminal settlement exists');
      const finalStatus = terminalEvents[0].payload.status;
      ok(['completed', 'blocked', 'failed', 'interrupted'].includes(finalStatus),
        `3: the settlement is a real terminal truth (${finalStatus})`);
      okEqual(await chainValid(recoveredRow.id), true, '3: the event chain remains valid through the recovery');
      scenario('3d: death ends in the SAME run + SAME attempt with exactly one truthful terminal settlement');

      await peerServer.stop();

      // ══════════════ 4. RESTART-A ═════════════════════════════════════════
      // Both processes from stage 3 are dead (one SIGKILLed, one stopped):
      // start ONE fresh process for the restart victim, drive a live claim,
      // then kill it — total process death singular, no peer alive.
      const restartOwner = await startServer({ env: baseEnv });
      const restartWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 restart victim ${STAMP}`, restartWorkflow.workflowId, restartOwner);
      let restartClaim = null;
      for (let i = 0; i < 140 && !restartClaim; i += 1) {
        await sleep(50);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) restartClaim = row;
      }
      ok(restartClaim, '4: a restart-victim run is live');
      await sleep(150);
      // Total deployment process loss while the run is live in memory.
      process.kill(restartOwner.child.pid, 'SIGKILL');
      await sleep(500);
      // Let the stale lease canonically expire BEFORE the cold boot, so the
      // startup recovery path (not a later scheduler pass) owns the recovery.
      for (let i = 0; i < 120; i += 1) {
        const row = (await store.pool.query(
          `SELECT lease_expires_at FROM ${store.table('runs')} WHERE id = $1`, [restartClaim.id])).rows[0];
        if (row && Date.parse(row.lease_expires_at) <= Date.now()) break;
        await sleep(250);
      }
      const staleRow = await latestRun();
      okEqual(staleRow.id, restartClaim.id, '4: after total process death the run keeps its authoritative identity');
      okEqual(staleRow.status, 'running', '4: the stale run is honestly stale (running + expired lease), never finished');

      const restarted = await startServer({ env: baseEnv });
      await sleep(700);
      let restartSettledRow = null;
      for (let i = 0; i < 320 && !restartSettledRow; i += 1) {
        await sleep(150);
        const row = await latestRun();
        if (row.id === restartClaim.id && !['pending', 'running'].includes(row.status)) restartSettledRow = row;
      }
      ok(restartSettledRow, '4: the restarted process reconstructed the stale run and settled it');
      okEqual(restartSettledRow.ticket_attempt_id, restartClaim.ticket_attempt_id, '4: the SAME attempt across the whole restart');
      const restartEvents = await eventsOf(restartClaim.id);
      const restartRecoveries = restartEvents.filter(event => event.type === 'run.recovery_claimed');
      okEqual(restartRecoveries.length, 1, '4: exactly one recovery claim for the stale run');
      okEqual(restartRecoveries[0].payload.mode, 'process_restart', '4: the recovery mode is the startup path');
      okEqual(restartEvents.filter(event => event.type === 'run.terminalized').length, 1,
        '4: one truthful settlement after restart recovery');
      okEqual(await chainValid(restartClaim.id), true, '4: the chain is valid after restart recovery');

      await restarted.stop();
      const restartedAgain = await startServer({ env: baseEnv });
      await sleep(900);
      const restartEvents2 = await eventsOf(restartClaim.id);
      okEqual(restartEvents2.filter(event => event.type === 'run.recovery_claimed').length, 1,
        '4: a second restart of a consistent deployment performs NO further recovery (idempotent)');
      okEqual(restartEvents2.filter(event => event.type === 'run.terminalized').length, 1, '4: nothing is settled twice');
      const restartAttemptRows = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('ticket_attempts')} WHERE ticket_id = $1`,
        [restartClaim.ticket_id])).rows[0].n;
      okEqual(restartAttemptRows, 1, '4: restart recovery NEVER minted a new attempt');
      scenario('4: cold restart reconstructs authoritative state from PostgreSQL; recovery is idempotent and NOT a retry');

      // ══════════════ 5. PG-OUTAGE-A + EVIDENCE-LATCH-A ════════════════════
      await restartedAgain.stop();
      const realUrl = new URL(databaseUrl);
      proxy = createPostgresConnectionProxy(Number(realUrl.port || 5432));
      const proxyPort = await proxy.listen();
      const proxiedUrl = new URL(databaseUrl);
      proxiedUrl.port = String(proxyPort);
      const outageEnv = { ...baseEnv, DATABASE_URL: proxiedUrl.toString() };
      const outageA = await startServer({ env: outageEnv });
      const outageB = await startServer({ env: outageEnv });
      await sleep(250);
      const outageCookieA = await loginCookie(outageA);

      proxy.cut();
      await sleep(300);
      const drop = response => {
        let body = {};
        try { body = JSON.parse(String(response && response.body || '{}')); } catch (_) {}
        return { statusCode: response && response.statusCode, body };
      };
      const outageHealthA = drop(await outageA.request('GET', '/health'));
      const outageHealthB = drop(await outageB.request('GET', '/health'));
      okEqual(outageHealthA.statusCode, 503, '5: outage → designed readiness refusal');
      okEqual(outageHealthB.statusCode, 503, '5: both processes honestly unready during the outage');
      okEqual(outageHealthA.body.status, 'unready', '5: the failure is the DESIGNED readiness projection');
      okEqual(outageHealthA.body.alive, true, '5: liveness stays true — the process answers even while unready');
      okEqual(outageHealthA.body.reason, 'postgres_unreachable', '5: the reason identifies PostgreSQL unreachability (sanitized)');
      ok(Boolean(outageHealthA.body.capacity && outageHealthA.body.capacity.mutationAdmission),
        '5: capacity observation stays intact during the outage');
      okEqual(outageHealthA.body.readiness.evidencePersistence, 'healthy', '5: no evidence latch from unreachability alone');
      scenario('5a: a real full outage fails closed with the designed readiness shape while liveness holds');

      const outagePost = await outageA.request('POST', '/tickets', {
        cookie: outageCookieA,
        form: { objective: `p6s3 outage post ${STAMP}`, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
      });
      bump();
      assert.ok(outagePost.statusCode >= 500 && outagePost.statusCode <= 503,
        `5: the outage mutation is REFUSED (HTTP ${outagePost.statusCode})`);
      ok(/error|Unavailable|terminated|refused|Connection|terminated/i.test(String(outagePost.body || '')),
        '5: the refusal honestly indicates the failed dependency (no silent success)');
      const leaked = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('tickets')} WHERE body->>'objective' = $1`,
        [`p6s3 outage post ${STAMP}`])).rows[0].n;
      okEqual(leaked, 0, '5: the refused outage mutation left NO durable state');
      scenario('5b: mutations refuse during the outage and leave no durable state');

      proxy.openUp();
      await sleep(900);
      const restoredA = drop(await outageA.request('GET', '/health'));
      const restoredB = drop(await outageB.request('GET', '/health'));
      okEqual(restoredA.statusCode, 200, '5: readiness restores per request after restoration — no restart');
      okEqual(restoredB.statusCode, 200, '5: both processes recover honestly');
      okEqual(restoredA.body.status, 'ok', '5: the designed OK shape returns after restoration');
      scenario('5c: after restoration the same processes become ready again with no restart and no manual clearing');

      // Real evidence-write failure latch (one process, real DB boundary).
      await store.pool.query(
        `CREATE OR REPLACE FUNCTION "${schema}".p6s3_latch_injector() RETURNS trigger AS $$
           BEGIN
             IF NEW.type = 'run.postconditions_checked' THEN
               RAISE EXCEPTION 'p6s3 injected evidence persistence failure';
             END IF;
             RETURN NEW;
           END; $$ LANGUAGE plpgsql;`);
      await store.pool.query(
        `CREATE TRIGGER p6s3_latch_injector_trg BEFORE INSERT ON ${store.table('events')}
           FOR EACH ROW EXECUTE FUNCTION "${schema}".p6s3_latch_injector();`);
      const latchServer = await startServer({ env: outageEnv });
      await sleep(250);
      const latchCookie = await loginCookie(latchServer);
      const latchWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 latch trigger ${STAMP}`, latchWorkflow.workflowId, latchServer);
      let latchedHealth = null;
      for (let i = 0; i < 220 && !latchedHealth; i += 1) {
        await sleep(150);
        const probe = drop(await latchServer.request('GET', '/health'));
        if (probe.body && probe.body.status === 'degraded') latchedHealth = probe;
      }
      ok(latchedHealth && latchedHealth.body.status === 'degraded',
        '5d: a real evidence-write failure latched the process (degraded, not backpressure)');
      okEqual(latchedHealth.body.reason, 'evidence_persistence_latched', '5d: the reason names the evidence latch');
      await store.pool.query(`DROP TRIGGER p6s3_latch_injector_trg ON ${store.table('events')}`);
      await store.pool.query(`DROP FUNCTION IF EXISTS "${schema}".p6s3_latch_injector();`);

      const latchedPost = await latchServer.request('POST', '/tickets', {
        cookie: latchCookie,
        form: { objective: `p6s3 after latch ${STAMP}`, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
      });
      ok(/EVENT_PERSISTENCE_UNAVAILABLE/.test(String(latchedPost.body || '')),
        `5d: post-latch mutations refuse with the designed fatal code (body ${String(latchedPost.body || '').slice(0, 90)})`);
      const latchLeak = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('tickets')} WHERE body->>'objective' = $1`,
        [`p6s3 after latch ${STAMP}`])).rows[0].n;
      okEqual(latchLeak, 0, '5d: the refused post-latch mutation left no durable state');
      // The latched claimer stops: freeze BOTH healthy processes so the only
      // LIVE claimer left is the latched one (its schedulers are stopped by
      // the process-wide latch). The suite then creates a fresh pending run
      // through the same repository authority the runtime uses — the run
      // MUST stay pending while the latched process is the only live claimer.
      process.kill(outageA.child.pid, 'SIGSTOP');
      process.kill(outageB.child.pid, 'SIGSTOP');
      const afterLatchTicket = await store.createTicket({
        status: 'open', title: `p6s3 after-latch ${STAMP}`, objective: `p6s3 after-latch ${STAMP}`,
        createdBy: 'p6-s3-hosted-recovery-postgres-test', changedBy: 'p6-s3-hosted-recovery-postgres-test'
      });
      await store.createRun({
        ticketId: afterLatchTicket.id,
        agentId: agent.id,
        agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot({
          maxExecutionSteps: 32, maxModelRequestsPerRun: 8,
          maxWorkspaceOperationsPerRun: 32, maxRuntimeDurationMs: 120000
        }),
        executionPolicySnapshot: { requireVerification: 'when_declared' },
        status: 'pending'
      });
      await sleep(1600);
      const pendingRow = await latestRun();
      okEqual(pendingRow.status, 'pending', '5d: the latched process STOPS claiming even with a free seat and no live peer');
      process.kill(outageA.child.pid, 'SIGCONT');
      process.kill(outageB.child.pid, 'SIGCONT');
      let latchWindowClaimed = false;
      for (let i = 0; i < 200 && !latchWindowClaimed; i += 1) {
        await sleep(150);
        const rowNow = await latestRun();
        if (rowNow.id === pendingRow.id && rowNow.status === 'running') latchWindowClaimed = true;
      }
      if (!latchWindowClaimed) {
        const seatNow = (await store.pool.query(
          `SELECT id, status, lease_owner FROM ${store.table('runs')} ORDER BY id DESC LIMIT 5`)).rows;
        console.log('5d-observation rows after CONT:', JSON.stringify(seatNow));
        const dumpTester = (label, server) => {
          console.log(`5d-observation ${label} stderr tail:`, (server.output ? server.output() : '<no output buffer>').slice(-1400));
        };
        dumpTester('outageA', outageA);
      }
      ok(latchWindowClaimed, '5d: the healthy peers claim automatically once their schedulers resume');
      const peerThroughLatch = drop(await outageA.request('GET', '/health'));
      okEqual(peerThroughLatch.statusCode, 200, '5d: the healthy peer stayed READY through the other process\u2019s latch');
      const latchPhysics = drop(await latchServer.request('GET', '/health'));
      okEqual(latchPhysics.statusCode, 503,
        `5d-latch: the latched health probe stays degraded (http ${latchPhysics.statusCode}, body ${JSON.stringify(latchPhysics.body).slice(0, 140)})`);
      okEqual(latchPhysics.body.status, 'degraded',
        '5d: the latched process never self-heals after the boundary is restored');
      scenario('5d: a latched process refuses mutations, stops claiming, and never self-heals — the peer stays healthy');

      await latchServer.stop();
      const restartedLatch = await startServer({ env: outageEnv });
      await sleep(300);
      const restartedLatchHealth = drop(await restartedLatch.request('GET', '/health'));
      okEqual(restartedLatchHealth.statusCode, 200, '5d: an operator restart recovers the latched process (fresh boot)');
      okEqual(restartedLatchHealth.body.status, 'ok', '5d: the restarted process is ready, not degraded');
      process.kill(outageA.child.pid, 'SIGSTOP');
      process.kill(outageB.child.pid, 'SIGSTOP');
      const postRestartTicket = await store.createTicket({
        status: 'open', title: `p6s3 post-restart claim ${STAMP}`, objective: `p6s3 post-restart claim ${STAMP}`,
        createdBy: 'p6-s3-hosted-recovery-postgres-test', changedBy: 'p6-s3-hosted-recovery-postgres-test'
      });
      await store.createRun({
        ticketId: postRestartTicket.id,
        agentId: agent.id,
        agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot({
          maxExecutionSteps: 32, maxModelRequestsPerRun: 8,
          maxWorkspaceOperationsPerRun: 32, maxRuntimeDurationMs: 120000
        }),
        executionPolicySnapshot: { requireVerification: 'when_declared' },
        status: 'pending'
      });
      let restartedClaim = null;
      for (let i = 0; i < 200 && !restartedClaim; i += 1) {
        await sleep(75);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) restartedClaim = row;
      }
      process.kill(outageA.child.pid, 'SIGCONT');
      process.kill(outageB.child.pid, 'SIGCONT');
      ok(restartedClaim && ownerPid(restartedClaim.lease_owner) === restartedLatch.child.pid,
        `5d: the restarted process claims PostgreSQL work itself (${JSON.stringify(restartedClaim && restartedClaim.lease_owner)})`);
      scenario('5e: latched recovery is an explicit operator restart; claiming resumes through normal authority');

      await outageA.stop();
      await outageB.stop();
      await restartedLatch.stop();

      // ══════════════ 6. DRAIN-A ═══════════════════════════════════════════
      const drainA = await startServer({ env: baseEnv });
      const drainB = await startServer({ env: baseEnv });
      const drainWorkflow = await createWriteWorkflow();
      await createTicket(`p6s3 drain victim ${STAMP}`, drainWorkflow.workflowId, drainA);
      let drainClaim = null;
      for (let i = 0; i < 140 && !drainClaim; i += 1) {
        await sleep(50);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) drainClaim = row;
      }
      ok(drainClaim, '6: a drain-victim run is live');
      const drainHolderPid = ownerPid(drainClaim.lease_owner);
      const drainHolder = drainHolderPid === drainA.child.pid ? drainA : drainB;
      drainHolder.child.kill('SIGTERM');
      let drainExit = null;
      for (let i = 0; i < 140 && drainExit === null; i += 1) {
        await sleep(150);
        drainExit = drainHolder.child.exitCode;
      }
      ok(drainExit !== null, '6: the drained process exited within the bounded drain path');
      okEqual(drainExit, 143, `6: the graceful bounded drain exits with its declared code (got ${drainExit})`);
      const drainRowAfter = await latestRun();
      if (drainRowAfter.id === drainClaim.id) {
        if (drainRowAfter.status === 'running') {
          ok(Date.parse(drainRowAfter.lease_expires_at) > Date.now() - 800,
            '6: a timed-out drain keeps the run recoverable under its authoritative lease — never fake-completed');
        } else if (drainRowAfter.status !== 'pending') {
          okEqual((await eventsOf(drainRowAfter.id)).filter(event => event.type === 'run.terminalized').length, 1,
            '6: a settled drain leaves exactly one truthful terminal settlement');
        }
      }
      // The stopped surface accepts nothing further.
      let refusedAfterShutdown = false;
      {
        const probe = await rawHealthProbe(drainHolder.port);
        if (probe === null) refusedAfterShutdown = true;
      }
      okEqual(refusedAfterShutdown, true, '6: the stopped process no longer accepts HTTP work');
      scenario('6a: the bounded drain exits honestly with the declared code and accepts no further work');

      const forcedWorkflow = await createWriteWorkflow();
      const forcedCreationTarget = drainHolder === drainA ? drainB : drainA;
      await createTicket(`p6s3 forced stop ${STAMP}`, forcedWorkflow.workflowId, forcedCreationTarget);
      let forcedClaim = null;
      for (let i = 0; i < 140 && !forcedClaim; i += 1) {
        await sleep(50);
        const row = await latestRun();
        if (row && row.status === 'running' && row.lease_owner) forcedClaim = row;
      }
      ok(forcedClaim, '6: a second live run observed before the forced stop');
      const forcedHolderPid = ownerPid(forcedClaim.lease_owner);
      const forcedHolder = forcedHolderPid === forcedCreationTarget.child.pid ? forcedCreationTarget : forcedHolderPid === drainHolder.child.pid ? drainHolder : null;
      ok(forcedHolder !== null, '6: the forced-stop holder is one of the two live processes');
      process.kill(forcedHolder.child.pid, 'SIGKILL');
      await sleep(300);
      const forcedRow = await latestRun();
      okEqual(forcedRow.id, forcedClaim.id, '6b: the forced-stop run keeps its identity');
      okEqual(forcedRow.status, 'running', '6b: an abrupt forced stop keeps the run honestly stale — never completed');
      scenario('6b: the forced-stop boundary never fabricates completion; the lease survives for a peer');

      // ══════════════ 7. HOST-LOCAL-A ══════════════════════════════════════
      const effectFiles = fs.readdirSync(workspaceRoot);
      const workflowEffects = effectFiles.filter(name => name.startsWith(`p6s3-run-${STAMP}-`));
      ok(workflowEffects.length >= 4,
        `7: multiple runs of multiple processes wrote into ONE host-local workspace root (${workflowEffects.length} files)`);
      scenario('7: two processes on one host share ONE host-local effect root; no shared-storage or multi-host claims');

      await drainA.stop();
      await drainB.stop();
      await proxy.close();
      proxy = null;
    }, { schemaSlug: 'p6s3_recovery' });

    console.log(`\nPASS: p6-s3 hosted recovery PostgreSQL suite (${scenariosRun} scenarios, ${assertionCount} assertions)`);
  } finally {
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(refusalWorkspace, { recursive: true, force: true }); } catch (_) {}
    if (proxy) { try { await proxy.close(); } catch (_) {} }
  }
}

main().catch(error => {
  console.error('\nFAIL: p6-s3 hosted recovery PostgreSQL suite');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
