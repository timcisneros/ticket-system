#!/usr/bin/env node
'use strict';

// P6-S2 owning PostgreSQL-native test (docs/ARCHITECTURAL_DECISIONS_PENDING.md
// P6 design freeze; docs/DEPLOYMENT_CONTRACT.md §6/§7/§9).
//
// Proves the honest readiness/health/capacity seams against REAL repository
// persistence — never through mocked status objects alone:
//
//   - the canonical readiness probe (`PostgresRuntimeStore.getMigrationStatus`)
//     on a real, current, disposable schema;
//   - the live /health and /api/health contract of a REAL server process
//     (200/ready/alive/capacity distinctness; capacity observable);
//   - readiness failure shapes when the migration ledger is ACTUALLY changed
//     under the running server (pending, unknown future, identity drift, and
//     missing ledger), with bounded designed 503s — never an accidental 500,
//     never mutated product state;
//   - per-request re-probing: restored state recovers readiness without a
//     restart (no indefinite cached failure and no startup-only truth);
//   - CAPACITY-A/B: mutation admission saturates, keeps refusing work through
//     its existing authority, and remains observable while /health stays
//     200/ready — saturation never becomes a readiness failure;
//   - the development doctor classifies the REAL disposable-development
//     ledger states (current / behind / unknown-future) with honest dev
//     semantics (behind = informational auto-migrate; corruption = FAIL with
//     `npm run dev:reset`) — and never claims operational migration
//     authorization for the dev channel;
//   - the missing disposable development DATABASE is informational (dev
//     provisioning);
//   - the OPERATIONAL migration-execution authority (T10) still refuses an
//     unauthorized pending transition on a defaulted (guarded) store, and the
//     refused transition applies nothing.
//
// All mutation/corruption happens inside the disposable harness schema and a
// sibling disposable schema — never the operational schema. No migration
// outside explicit disposable-migration authority runs; migration 044 stays
// unopened. Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createTestSchemaName, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { PostgresRuntimeStore, migrationFiles, migrationChecksum, quoteIdentifier } = require('../persistence/postgres/store');
const { probePostgresReadiness, buildHealthProjection, classifyMigrationStatus } = require('../runtime/health-readiness');
const { validateEnvironment } = require('../runtime/environment-config-registry');
const { inspectDevelopmentEnvironment } = require('./dev-doctor');
const { runOperationalPreflight } = require('./operational-preflight');
const { MigrationExecutionAuthorityError } = require('../persistence/postgres/migration-authority');

const SATISFIED_PROJECTION_CONFIGURATION = validateEnvironment({
  DATABASE_URL: 'postgresql://probe:probe@localhost:5432/ticket_system',
  SESSION_SECRET: 'x'.repeat(64)
});

const STAMP = Date.now();
// A locally counting asserter: every node-style strict assertion increments
// `assertCount()` so the settlement scorer can prove the suite reached and
// held its assertions (assert/strict semantics throughout).
let assertionCount = 0;
function bump() { assertionCount += 1; }
const style = require('assert/strict');
const harnessAssert = (condition, message) => { bump(); style.ok(condition, message); };
harnessAssert.equal = (actual, expected, message) => { bump(); style.strictEqual(actual, expected, message); };
harnessAssert.deepEqual = (actual, expected, message) => { bump(); style.deepStrictEqual(actual, expected, message); };
harnessAssert.match = (actual, regexp, message) => { bump(); style.match(actual, regexp, message); };
harnessAssert.doesNotMatch = (actual, regexp, message) => { bump(); style.doesNotMatch(actual, regexp, message); };
harnessAssert.notEqual = (actual, expected, message) => { bump(); style.notStrictEqual(actual, expected, message); };
harnessAssert.ok = (value, message) => { bump(); style.ok(value, message); };
harnessAssert.count = () => assertionCount;
const assert = harnessAssert;
let scenariosRun = 0;

const env = process.env;

function parse(body) {
  try { return JSON.parse(body); } catch (_) { return {}; }
}

const SCHEMA_HEAD_EXPECTED = migrationFiles()[migrationFiles().length - 1];

async function main() {
  await withHarness('p6 s2 readiness', async ({ store, schema, databaseUrl, startServer, workspaceRoot }) => {
    const schemaSql = quoteIdentifier(schema);

    // ── 1. Canonical readiness facts on a real current ledger ────────────
    const status = await store.getMigrationStatus();
    assert.equal(status.fullyApplied, true, '1: the harness schema is fully migrated (canonical owner)');
    assert.equal(status.checksumsValid, true, '1: identities of the applied ledger are valid');
    assert.equal(status.partial, false, '1: the ledger is not partial');
    assert.equal(status.unknownMigrations, 0, '1: no unknown future migrations');
    assert.equal(status.pendingMigrations, 0, '1: no pending migrations');
    const classified = classifyMigrationStatus(status);
    assert.equal(classified.compatible, true);
    assert.equal(classified.code, 'migrations_current');
    assert.equal((await migrationFiles()).pop(), SCHEMA_HEAD_EXPECTED, '1: canonical enumeration comes from the repository migration set');
    assert.equal(migrationChecksum(SCHEMA_HEAD_EXPECTED).length, 64, '1: identity digests are sha256-hex (sha256-hex-checked, no second evaluator here)');
    scenario('1: canonical migration-status probe owns the readiness facts on a real schema');

    // ── 2. Health probes never mutate product/database state ────────────
    const preProbe = await store.pool.query(`SELECT (SELECT count(*) FROM ${schemaSql}."schema_migrations") AS ledger, (SELECT count(*) FROM ${schemaSql}."schema_migration_identities") AS identities`);
    const probeStoreRead = await probePostgresReadiness(store);
    assert.equal(probeStoreRead.reachable, true);
    for (let index = 0; index < 3; index += 1) {
      await probePostgresReadiness(store);
    }
    const postProbe = await store.pool.query(`SELECT (SELECT count(*) FROM ${schemaSql}."schema_migrations") AS ledger, (SELECT count(*) FROM ${schemaSql}."schema_migration_identities") AS identities`);
    assert.equal(postProbe.rows[0].ledger, preProbe.rows[0].ledger, '2: health probes write no ledger rows');
    assert.equal(postProbe.rows[0].identities, preProbe.rows[0].identities, '2: health probes write no identity rows');
    scenario('2: read-only cadence — repeated probes mutate nothing');

    // ── 3. The live server contract (both public routes) ─────────────────
    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '5000' } });
    await server.login();

    const healthResponse = await server.request('GET', '/health');
    assert.equal(healthResponse.statusCode, 200, `3: /health ready at HTTP ${healthResponse.statusCode}`);
    const healthBody = parse(healthResponse.body);
    assert.equal(healthBody.ready, true, '3: /health ready');
    assert.equal(healthBody.alive, true, '3: /health alive');
    assert.equal(healthBody.status, 'ok', '3: /health status ok');
    assert.ok(healthBody.projectionVersion >= 1, '3: projection version present');
    assert.equal(healthBody.readiness, undefined, '3: ready payloads carry no diagnosis block');
    assert.equal(healthBody.uptime, undefined, '3: /health omits uptime (pre-existing shape)');
    assert.ok(healthBody.capacity && healthBody.capacity.mutationAdmission &&
      healthBody.capacity.mutationAdmission.role === 'mutation_admission',
      '3: capacity is observable with the existing admission-metrics contract');
    assert.ok(healthBody.processExecutionRelease && typeof healthBody.processExecutionRelease.state === 'string',
      '3: the process-execution release surface stays attached');

    const apiHealthResponse = await server.request('GET', '/api/health');
    assert.equal(apiHealthResponse.statusCode, 200);
    const apiBody = parse(apiHealthResponse.body);
    assert.equal(apiBody.ready, true);
    assert.equal(apiBody.alive, true);
    assert.equal(apiBody.status, 'ok');
    assert.equal(typeof apiBody.uptime, 'number', '3: /api/health keeps numeric uptime');
    assert.equal(apiHealthResponse.headers['x-content-type-options'], 'nosniff', '3: security headers survive on health routes');
    scenario('3: live /health and /api/health expose liveness/readiness/capacity distinctly');

    // ── 4. Doctor classifies the REAL current ledger ─────────────────────
    const doctorStoreFactory = () => new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    const doctorResult = await inspectDevelopmentEnvironment({
      storeFactory: config => doctorStoreFactory(),
      env: {
        ...env,
        DATABASE_URL: databaseUrl,
        POSTGRES_SCHEMA: schema,
        SESSION_SECRET: 'p6s2-doctor-healthy-development-secret-0123456789abcdef'
      }
    });
    const migrationRows = doctorResult.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.ok(migrationRows.length === 1, '4: doctor renders exactly one migration-ledger row per run');
    assert.equal(migrationRows[0].status, 'pass', '4: current ledger classifies CURRENT');
    assert.match(migrationRows[0].message, /current/, '4: the row states the current truth');
    scenario('4: doctor reports the real current ledger as CURRENT');

    // ── 5. CAPACITY-A/B: saturation is observable but never readiness ────
    const agent = (await store.createConfiguredAgent({
      value: { name: `Readiness-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'p6s2-test-only' },
      groupIds: [], changedBy: 'p6-s2-readiness-postgres-test'
    })).agent;
    const saturatedServer = await startServer({ env: {
      MUTATION_ADMISSION_MAX_OUTSTANDING: '2',
      RUNTIME_SCHEDULER_INTERVAL_MS: '5000'
    } });
    const saturatedCookie = await saturatedServer.login();
    const createTicket = objective => saturatedServer.request('POST', '/tickets', {
      cookie: saturatedCookie,
      form: {
        objective,
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
      }
    });
    const burst = Array.from({ length: 12 }, (_, index) => `readiness saturation ${index} ${STAMP}`);
    // Fire without awaiting so the probes observe live admission pressure.
    const burstPromise = Promise.all(burst.map(createTicket));
    const saturationProbes = [];
    for (let index = 0; index < 12; index += 1) {
      saturationProbes.push(await saturatedServer.request('GET', '/health'));
      await sleep(30);
    }
    const burstResponses = await burstPromise;
    scenario('5: polled health through the saturation window');

    assert.ok(burstResponses.every(response => response.statusCode === 503 || response.statusCode === 302 ||
      response.statusCode === 200),
      '5: no accidental failures beyond designed admission refusals');
    // 5a. Capacity authority preserved: real refusals with the recoverable code.
    const refusals = burstResponses.filter(response => response.statusCode === 503);
    assert.ok(refusals.length > 0, '5a: saturation produced admission refusals through the existing authority');
    assert.ok(refusals.every(response => parse(response.body).code === 'MUTATION_ADMISSION_BACKPRESSURED'),
      `5a: refusals carry the recoverable capacity code (${[...new Set(refusals.map(r => parse(r.body).code))].join(', ')})`);
    scenario('5a: mutation admission still refuses work through its existing authority while saturated');

    // 5b. THE P6-S2 CORRECTION: saturation never became a readiness failure.
    assert.ok(saturationProbes.length > 0, '5b: at least one health probe through the window');
    for (const probe of saturationProbes) {
      assert.equal(probe.statusCode, 200, `5b: a health probe during saturation returned HTTP ${probe.statusCode}`);
      const body = parse(probe.body);
      assert.equal(body.ready, true, '5b: never unready merely because capacity was saturated');
      assert.equal(body.alive, true);
      assert.ok(body.capacity && body.capacity.mutationAdmission, '5b: capacity stays observable');
    }
    const observedPressure = saturationProbes.map(probe => parse(probe.body))
      .some(body => (body.capacity.mutationAdmission.current.outstanding || 0) > 0 ||
        body.capacity.mutationAdmission.current.backpressured === true);
    assert.equal(observedPressure, true,
      '5b: the window observed live admission pressure (outstanding>0 or backpressured)');
    assert.ok(burstResponses.some(response => response.statusCode === 302 || response.statusCode === 200),
      '5b: capacity did not simply close; some work still admitted');
    scenario('5b: saturation is observable in health and never marks the process unready');

    // ── 5c. OP-PREFLIGHT-A: the operational deployment preflight against one
    // LIVE disposable schema. The preflight's own owner (its CLI) proves the
    // no-contact refusal shapes; this scenario proves the LIVE composition on
    // real PostgreSQL: the canonical configuration gate, the exact resolved
    // operational identity (credential-free), effect-root usability, the
    // canonical ledger/identity facts, the T10 integrity gate, and the
    // read-only agent observation — all through the same code the runbook
    // requires, with zero writes.
    {
      const preflightEnv = {
        ...env,
        DATABASE_URL: databaseUrl,
        POSTGRES_SCHEMA: schema,
        SESSION_SECRET: 'p6s2-operational-preflight-secret-0123456789abcdef'
      };
      const agentsBefore = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('configured_agents')}`
      )).rows[0].n;
      const preflight = await runOperationalPreflight({
        env: preflightEnv,
        cwd: workspaceRoot
      });
      assert.equal(preflight.ok, true, '5c: the operational preflight passes against a live current schema');
      assert.equal((preflight.facts.configuration || {}).ok, true, '5c: the canonical registry gate passes');
      assert.equal(preflight.facts.channel, 'environment', '5c: the exact operational channel is the resolved authority');
      assert.match(preflight.lines.join('\n'), /host 127\.0\.0\.1, port \d+, database \S+, schema tstharness_p6/,
        '5c: the preflight prints the exact resolved operational identity');
      assert.doesNotMatch(preflight.lines.join('\n'), /postgresql/,
        '5c: the rendered preflight identity is credential-free');
      assert.ok((preflight.facts.effectRoots || []).every(entry => entry.usable),
        '5c: effect-root usability is established through the canonical walk');
      assert.equal((preflight.facts.migration || {}).code, 'migrations_current',
        '5c: the live preflight classifies the current ledger canonically');
      const agentsAfter = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('configured_agents')}`
      )).rows[0].n;
      assert.equal(agentsAfter, agentsBefore, '5c: the preflight wrote no agent catalog rows');
      assert.match(preflight.lines.join('\n'), /read-only preflight passed/,
        '5c: the passing preflight concludes honestly (read-only posture)');
      scenario('5c: the operational deployment preflight composes canonical owners on live PostgreSQL with zero writes');
    }

    // ── 6. Readiness fails on REAL ledger changes under the running server ─
    const headVersion = SCHEMA_HEAD_EXPECTED;

    // 6a. missing/pending: remove the head ledger row (disposable schema only).
    // The identity ledger FK-references schema_migrations, so the identity row
    // moves with the ledger row inside this controlled corruption step.
    await store.pool.query(`ALTER TABLE ${schemaSql}.schema_migration_identities DISABLE TRIGGER schema_migration_identities_append_only`);
    try {
      await store.pool.query(`DELETE FROM ${schemaSql}.schema_migration_identities WHERE version = $1`, [headVersion]);
      await store.pool.query(`DELETE FROM ${schemaSql}.schema_migrations WHERE version = $1`, [headVersion]);
      const pendingAttempt = await server.request('GET', '/health');
      assert.equal(pendingAttempt.statusCode, 503, `6a: a pending ledger is a designed readiness failure (${pendingAttempt.statusCode})`);
      const pendingBody = parse(pendingAttempt.body);
      assert.equal(pendingBody.ready, false);
      assert.equal(pendingBody.alive, true, '6a: liveness stays true while the probe refuses readiness');
      assert.equal(pendingBody.status, 'unready');
      assert.equal(pendingBody.reason, 'migrations_incompatible');
      assert.equal(pendingBody.readiness.migrations.code, 'migrations_pending');
      assert.equal(pendingBody.readiness.migrations.facts.pendingMigrations, 1);
      assert.notEqual(pendingBody.readiness, undefined);
      // 6a-restore: per-request re-probing must recover without a restart.
      await store.pool.query(`INSERT INTO ${schemaSql}.schema_migrations (version) VALUES ($1)`, [headVersion]);
      await store.pool.query(
        `INSERT INTO ${schemaSql}.schema_migration_identities (version, sha256) VALUES ($1, $2)`,
        [headVersion, migrationChecksum(headVersion)]
      );
      const restoredAfterPending = await server.request('GET', '/health');
      assert.equal(restoredAfterPending.statusCode, 200, '6a: restored ledger makes the process ready again (no cached failure)');
    } finally {
      await store.pool.query(`ALTER TABLE ${schemaSql}.schema_migration_identities ENABLE TRIGGER schema_migration_identities_append_only`);
    }
    scenario('6a: pending ledger → designed 503, and per-request recovery after restore');

    // 6b. unknown future migration.
    await store.pool.query(`INSERT INTO ${schemaSql}.schema_migrations (version) VALUES ($1)`, ['099_not_from_this_repository.sql']);
    const unknownAttempt = await server.request('GET', '/health');
    assert.equal(unknownAttempt.statusCode, 503, '6b: unknown future migrations refuse readiness');
    const unknownBody = parse(unknownAttempt.body);
    assert.equal(unknownBody.reason, 'migrations_incompatible');
    assert.equal(unknownBody.readiness.migrations.code, 'migrations_unknown');
    assert.equal(unknownBody.readiness.migrations.facts.unknownMigrations, 1);
    await store.pool.query(`DELETE FROM ${schemaSql}.schema_migrations WHERE version = $1`, ['099_not_from_this_repository.sql']);
    const restoredAfterUnknown = await server.request('GET', '/health');
    assert.equal(restoredAfterUnknown.statusCode, 200, '6b: after removal readiness recovers per request');
    scenario('6b: unknown future migration → readiness false with canonical facts');

    // 6c. checksum identity drift (tailored to the disposable schema).
    await store.pool.query(`ALTER TABLE ${schemaSql}.schema_migration_identities DISABLE TRIGGER schema_migration_identities_append_only`);
    try {
      await store.pool.query(
        `UPDATE ${schemaSql}.schema_migration_identities SET sha256 = $1 WHERE version = $2`,
        ['0'.repeat(64), headVersion]
      );
      const driftAttempt = await server.request('GET', '/health');
      assert.equal(driftAttempt.statusCode, 503, '6c: identity drift refuses readiness (checksum identity invalid)');
      const driftBody = parse(driftAttempt.body);
      assert.equal(driftBody.reason, 'migrations_incompatible');
      assert.equal(driftBody.readiness.migrations.code, 'migrations_partial', '6c: canonical partial fact classifies as drift');
      // restore
      await store.pool.query(
        `UPDATE ${schemaSql}.schema_migration_identities SET sha256 = $1 WHERE version = $2`,
        [migrationChecksum(headVersion), headVersion]
      );
      const restoredAfterDrift = await server.request('GET', '/health');
      assert.equal(restoredAfterDrift.statusCode, 200, '6c: restored identity restores readiness per request');
    } finally {
      await store.pool.query(`ALTER TABLE ${schemaSql}.schema_migration_identities ENABLE TRIGGER schema_migration_identities_append_only`);
    }
    scenario('6c: checksum identity failure → readiness false; restore → ready again');

    // 6d. missing ledger table.
    await store.pool.query(`DROP TABLE ${schemaSql}.schema_migrations CASCADE`);
    const droppedAttempt = await server.request('GET', '/health');
    assert.equal(droppedAttempt.statusCode, 503, '6d: a missing ledger is incompatible, not healthy');
    const droppedBody = parse(droppedAttempt.body);
    assert.equal(droppedBody.reason, 'migrations_incompatible');
    assert.equal(droppedBody.readiness.migrations.code, 'migrations_pending', '6d: the canonical missing-ledger shape reports pending head-relative facts');
    assert.equal(droppedBody.readiness.migrations.facts.fullyApplied, false);

    // Liveness during every failure above: the process kept ANSWERING.
    const finalPing = await server.request('GET', '/api/health');
    assert.equal(lastResponseIsDesigned(finalPing), true, '6: final health response is designed JSON, never an unhandled 500');
    scenario('6: real ledger incompatibilities produce designed bounded readiness failures while liveness holds');

    await server.stop();
    await saturatedServer.stop();

    // ── 7. PostgreSQL-unavailable → readiness false, liveness untouched ────
    const unreachableStore = new PostgresRuntimeStore({
      connectionString: 'postgresql://probe:probe@127.0.0.1:1/no-such-database',
      connectionTimeoutMs: 750
    });
    try {
      const outage = await probePostgresReadiness(unreachableStore);
      assert.equal(outage.reachable, false, '7: the canonical probe marks an unreachable PostgreSQL');
      assert.ok(outage.failure && outage.failure.code, '7: the sanitized failure carries a deterministic code');
      assert.equal(JSON.stringify(outage.failure).includes('probe:probe'), false, '7: credentials are never surfaced');
      const outageProjection = buildHealthProjection({
        postgresProbe: outage,
        admissionMetrics: { role: 'mutation_admission' },
        configurationFailures: SATISFIED_PROJECTION_CONFIGURATION
      });
      assert.equal(outageProjection.statusCode, 503, '7: outage → 503 readiness');
      assert.equal(outageProjection.payload.alive, true, '7: liveness is untouched by PostgreSQL unavailability');
      assert.equal(outageProjection.payload.reason, 'postgres_unreachable');
    } finally {
      await unreachableStore.close();
    }
    scenario('7: PostgreSQL unavailable → readiness false, 503 designed, liveness true (canonical store seam)');

    // ── 7b. HEALTH-COOKIE-A: cookie-bearing public observation during a REAL
    // server-process outage. A REAL server keeps a REAL login session while
    // its ONLY PostgreSQL transit runs through a suite-owned severing proxy;
    // cut() is the existing real outage seam. A request carrying that valid
    // session cookie must reach the health projection WITHOUT any PostgreSQL
    // session lookup or write — mechanically identical to the anonymous
    // observation — and readiness must restore per request. This is the
    // session-bypass correction demanded for /health and /api/health (one
    // projection, no second implementation, authenticated routes untouched).
    {
      const observationBackend = new URL(databaseUrl);
      let observationOpen = true;
      const observationSockets = new Set();
      const observationServerSeam = require('node:net').createServer(client => {
        if (!observationOpen) { client.destroy(); return; }
        const upstream = require('node:net').connect(Number(observationBackend.port || 5432), '127.0.0.1');
        observationSockets.add(client); observationSockets.add(upstream);
        const fail = () => { try { client.destroy(); } catch (_) {} try { upstream.destroy(); } catch (_) {} observationSockets.delete(client); observationSockets.delete(upstream); };
        client.on('data', chunk => { if (observationOpen) { try { upstream.write(chunk); } catch (_) { fail(); } } else { fail(); } });
        upstream.on('data', chunk => { try { client.write(chunk); } catch (_) { fail(); } });
        client.on('error', fail); upstream.on('error', fail);
        client.on('close', () => { try { upstream.destroy(); } catch (_) {} fail(); });
        upstream.on('close', () => { try { client.destroy(); } catch (_) {} fail(); });
      });
      const severProxy = {
        listen: () => new Promise((resolve, reject) => { observationServerSeam.once('error', reject); observationServerSeam.listen(0, '127.0.0.1', () => resolve(observationServerSeam.address().port)); }),
        cut() { observationOpen = false; for (const socket of observationSockets) { try { socket.destroy(); } catch (_) {} } observationSockets.clear(); },
        openUp() { observationOpen = true; },
        close: () => { observationOpen = false; for (const socket of observationSockets) { try { socket.destroy(); } catch (_) {} } observationSockets.clear(); return new Promise(resolve => observationServerSeam.close(resolve)); }
      };
      let observationServer = null;
      let observationSchemaStore = null;
      const observationSchema = createTestSchemaName('p6s2_cookiepicture'.slice(0, 24));
      try {
        // The main harness schema intentionally ends section 6 without its
        // ledger (6d's designed drift probe), so the observation server gets
        // its OWN disposable schema (same explicit migration authority).
        observationSchemaStore = new PostgresRuntimeStore({
          connectionString: databaseUrl,
          schema: observationSchema,
          disposableMigrations: true
        });
        await observationSchemaStore.pool.query(`DROP SCHEMA IF EXISTS "${observationSchema}" CASCADE`);
        await observationSchemaStore.pool.query(`CREATE SCHEMA "${observationSchema}"`);
        await observationSchemaStore.migrate();
        const observationBackend = new URL(databaseUrl);
        const observationSockets = new Set();
        let observationOpen = true;
        const observationServerSeam = require('node:net').createServer(client => {
          if (!observationOpen) { client.destroy(); return; }
          const upstream = require('node:net').connect(Number(observationBackend.port || 5432), '127.0.0.1');
          observationSockets.add(client); observationSockets.add(upstream);
          const fail = () => { try { client.destroy(); } catch (_) {} try { upstream.destroy(); } catch (_) {} observationSockets.delete(client); observationSockets.delete(upstream); };
          client.on('data', chunk => { if (observationOpen) { try { upstream.write(chunk); } catch (_) { fail(); } } else { fail(); } });
          upstream.on('data', chunk => { try { client.write(chunk); } catch (_) { fail(); } });
          client.on('error', fail); upstream.on('error', fail);
          client.on('close', () => { try { upstream.destroy(); } catch (_) {} fail(); });
          upstream.on('close', () => { try { client.destroy(); } catch (_) {} fail(); });
        });
        const severProxy = {
          listen: () => new Promise((resolve, reject) => { observationServerSeam.once('error', reject); observationServerSeam.listen(0, '127.0.0.1', () => resolve(observationServerSeam.address().port)); }),
          cut() { observationOpen = false; for (const socket of observationSockets) { try { socket.destroy(); } catch (_) {} } observationSockets.clear(); },
          openUp() { observationOpen = true; },
          close: () => { observationOpen = false; for (const socket of observationSockets) { try { socket.destroy(); } catch (_) {} } observationSockets.clear(); return new Promise(resolve => observationServerSeam.close(resolve)); }
        };
        try {
          const observationProxyPort = await severProxy.listen();
          const observationSeverUrl = new URL(databaseUrl);
          observationSeverUrl.port = String(observationProxyPort);
          observationServer = await startServer({ env: {
            RUNTIME_SCHEDULER_INTERVAL_MS: '5000',
            DATABASE_URL: observationSeverUrl.toString(),
            POSTGRES_SCHEMA: observationSchema
          } });
          const observationCookie = await observationServer.login();

          const sessionsBefore = (await observationSchemaStore.pool.query(
            `SELECT count(*)::int AS n, max(updated_at)::text AS newest FROM ${quoteIdentifier(observationSchema)}.http_sessions`
          )).rows[0];
          const labeledHealth = await observationServer.request('GET', '/health', { cookie: observationCookie });
          assert.equal(labeledHealth.statusCode, 200, `7b: healthy observation WITH the session cookie stays ready (${labeledHealth.statusCode})`);

          const touchedAtLogin = (await observationSchemaStore.pool.query(
            `SELECT count(*)::int AS n FROM ${quoteIdentifier(observationSchema)}.http_sessions`
          )).rows[0];
          assert.equal(touchedAtLogin.n, sessionsBefore.n,
            '7b: the healthy observation wrote no session row at all');

          severProxy.cut();
          await sleep(400);
          // THE invariant: a valid session cookie must not couple /health or
          // /api/health to the session store.
          const cookieOutage = await observationServer.request('GET', '/health', { cookie: observationCookie });
          assert.equal(cookieOutage.statusCode, 503, `7b: outage observation WITH the cookie is the designed 503 (${cookieOutage.statusCode})`);
          const cookieOutageBody = parse(cookieOutage.body);
          assert.equal(cookieOutageBody.alive, true, '7b: liveness holds for cookie-bearing observation');
          assert.equal(cookieOutageBody.reason, 'postgres_unreachable', '7b: the outage reason is the canonical one (not a session failure)');

          const anonymousOutage = await observationServer.request('GET', '/health');
          assert.equal(anonymousOutage.statusCode, 503, '7b: cookie-less outage observation is the same designed 503');
          assert.deepEqual(parse(anonymousOutage.body), cookieOutageBody,
            '7b: cookie-bearing and cookie-less outage observations return the SAME projection');

          const apiCookieOutage = await observationServer.request('GET', '/api/health', { cookie: observationCookie });
          assert.equal(apiCookieOutage.statusCode, 503, `7b: /api/health with the cookie refuses into the designed projection (${apiCookieOutage.statusCode})`);
          const apiCookieOutageBody = parse(apiCookieOutage.body);
          assert.equal(apiCookieOutageBody.reason, 'postgres_unreachable', '7b: /api/health outage reason is canonical with the cookie');
          assert.ok(typeof apiCookieOutageBody.uptime === 'number', '7b: /api/health keeps its uptime contract with the cookie');
          assert.equal(String(cookieOutageBody.error || '').includes('session'), false,
            '7b: no session-stack failure surfaces on the observation plane');

          // After the outage, the SAME session still owns exactly its row and no
          // observation tried (or succeeded) to write session state.
          severProxy.openUp();
          await sleep(900);
          const restoredCookieHealth = await observationServer.request('GET', '/health', { cookie: observationCookie });
          assert.equal(restoredCookieHealth.statusCode, 200, `7b: restoration restores readiness for the same cookie-bearing client (${restoredCookieHealth.statusCode})`);
          assert.equal((parse(restoredCookieHealth.body)).ready, true, '7b: restored readiness is the designed true');
          const sessionsAfter = (await observationSchemaStore.pool.query(
            `SELECT count(*)::int AS n, max(updated_at)::text AS newest FROM ${quoteIdentifier(observationSchema)}.http_sessions`
          )).rows[0];
          assert.equal(sessionsAfter.n, touchedAtLogin.n, '7b: no NEW session row appeared (observation never materialized sessions)');
          assert.equal(sessionsAfter.newest, sessionsBefore.newest,
            '7b: no session row was touched by any observation (session-store writes are impossible here)');
          scenario('7b: cookie-bearing public observation bypasses PostgreSQL session I/O through a real outage and returns the canonical projection');
        } finally {
          if (observationServer) { try { await observationServer.stop(); } catch (_) {} }
          try { await severProxy.close(); } catch (_) {}
        }
      } finally {
        if (observationSchemaStore) {
          try { await observationSchemaStore.pool.query(`DROP SCHEMA IF EXISTS "${observationSchema}" CASCADE`); } catch (_) {}
          try { await observationSchemaStore.close(); } catch (_) {}
        }
      }
    }
  });

  // ── 8. Sibling disposable schemas: doctor dev-ledger states + T10 refusal ─
  const databaseUrl = env.TEST_DATABASE_URL || env.DATABASE_URL;
  const siblingSchema = createTestSchemaName('p6s2-behindUnauthorized'.slice(0, 24));
  const sibling = new PostgresRuntimeStore({
    connectionString: databaseUrl,
    schema: siblingSchema,
    disposableMigrations: true
  });
  try {
    await sibling.pool.query(`DROP SCHEMA IF EXISTS "${siblingSchema}" CASCADE`);
    await sibling.pool.query(`CREATE SCHEMA "${siblingSchema}"`);
    await sibling.migrate();
    const schemaSql = quoteIdentifier(siblingSchema);
    const appliedBefore = await sibling.pool.query(`SELECT count(*)::int AS n FROM ${schemaSql}.schema_migrations`);
    assert.equal(appliedBefore.rows[0].n, migrationFiles().length, '8: the sibling schema reaches full parity (explicit disposable authority)');
    // Tamper the operational truth INSIDE the disposable sibling only.
    // The identity ledger FK-references schema_migrations, so the identity
    // row moves with the ledger row inside this controlled corruption step.
    await sibling.pool.query(
      `ALTER TABLE ${schemaSql}.schema_migration_identities DISABLE TRIGGER schema_migration_identities_append_only`
    );
    try {
      await sibling.pool.query(
        `DELETE FROM ${schemaSql}.schema_migration_identities WHERE version = $1`,
        [migrationFiles()[migrationFiles().length - 1]]
      );
      await sibling.pool.query(
        `DELETE FROM ${schemaSql}.schema_migrations WHERE version = $1`,
        [migrationFiles()[migrationFiles().length - 1]]
      );
    } finally {
      await sibling.pool.query(
        `ALTER TABLE ${schemaSql}.schema_migration_identities ENABLE TRIGGER schema_migration_identities_append_only`
      );
    }

    // 8a. Doctor classifies the REAL behind state with the disposable
    // development semantics: behind is INFORMATIONAL (the dev command
    // auto-migrates this code-declared disposable target), and the row makes
    // NO authorization claim — dev channels never decide or claim T10.
    const behindDoctor = await inspectDevelopmentEnvironment({
      storeFactory: () => new PostgresRuntimeStore({ connectionString: databaseUrl, schema: siblingSchema }),
      env: {
        ...env,
        DATABASE_URL: databaseUrl,
        POSTGRES_SCHEMA: siblingSchema,
        SESSION_SECRET: 'p6s2-doctor-behind-development-secret-0123456789abcdef'
      }
    });
    const behindRows = behindDoctor.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.ok(behindRows.length === 1, '8a: one ledger row');
    assert.equal(behindRows[0].status, 'info', '8a: a behind disposable development ledger is informational');
    assert.match(behindRows[0].message, /behind the canonical migration source by 1/i, '8a: the row reports the dev schema is behind');
    assert.match(behindRows[0].message, /auto-migrate/i, '8a: the row states `npm run dev` auto-migrates the dev target');
    assert.doesNotMatch(behindRows[0].message, /IS authorized/i, '8a: the dev ledger row never claims authorization');
    assert.ok(behindDoctor.checks.some(check =>
      check.status === 'info' && check.label.startsWith('Operational database')), '8a: exactly the informational operational row exists');
    scenario('8a: doctor classifies a real BEHIND disposable development ledger informationally (auto-migrate)');

    // 8a-3. OP-PREFLIGHT-A: the OPERATIONAL preflight treats the same behind
    // ledger as a canonical refusal (a server cannot start against it), on the
    // real sibling schema, still without a single write.
    {
      const siblingPreflight = await runOperationalPreflight({
        env: {
          ...env,
          DATABASE_URL: databaseUrl,
          POSTGRES_SCHEMA: siblingSchema,
          SESSION_SECRET: 'p6s2-operational-preflight-secret-0123456789abcdef'
        },
        cwd: process.cwd()
      });
      assert.equal(siblingPreflight.ok, false, '8a-3: the operational preflight refuses a behind ledger');
      assert.match(String(siblingPreflight.reason), /not compatible with this source/,
        '8a-3: the refusal names the canonical incompatibility');
      assert.match(String(siblingPreflight.reason), /pending migrations: 1/,
        '8a-3: the refusal carries the exact pending count as the canonical probe does');
      assert.match(String(siblingPreflight.reason), /never from this preflight/,
        '8a-3: the preflight never offers or performs the migration itself');
      assert.equal((siblingPreflight.facts.migration || {}).code, 'migrations_pending',
        '8a-3: the canonical behind classification is surfaced');
      const siblingAgentCount = (await sibling.pool.query(
        `SELECT count(*)::int AS n FROM ${quoteIdentifier(siblingSchema)}.configured_agents`
      )).rows[0];
      assert.equal(siblingAgentCount.n, 0,
        '8a-3: the sibling schema stays intact through the refusing preflight (read-only)');
      scenario('8a-3: the operational preflight refuses a live behind ledger canonically (T10-guarded truth)');
    }

    // 8a-2. Unknown future migration → the doctor FAILS the row with exactly
    // the `dev:reset` remediation (destroy/recreate ONLY the disposable dev
    // identity) — never a guessed operational remediation.
    const unknownVersion = '099_not_from_this_repository.sql';
    let appliedCountBeforeUnknown = 0;
    await sibling.withTransaction(async client => {
      appliedCountBeforeUnknown = (await client.query(`SELECT count(*)::int AS n FROM ${schemaSql}.schema_migrations`)).rows[0].n;
    });
    await sibling.pool.query(`INSERT INTO ${schemaSql}.schema_migrations (version) VALUES ($1)`, [unknownVersion]);
    const unknownDoctor = await inspectDevelopmentEnvironment({
      storeFactory: () => new PostgresRuntimeStore({ connectionString: databaseUrl, schema: siblingSchema }),
      env: {
        ...env,
        DATABASE_URL: databaseUrl,
        POSTGRES_SCHEMA: siblingSchema,
        SESSION_SECRET: 'p6s2-doctor-unknown-development-secret-0123456789abcdef'
      }
    });
    const unknownRows = unknownDoctor.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.equal(unknownRows[0].status, 'fail', '8a-2: an unknown future migration fails the doctor');
    assert.match(unknownRows[0].message, /unknown future migrations/i, '8a-2: the row names the incompatibility');
    assert.match(unknownRows[0].message, /dev:reset/, '8a-2: the remediation is exactly the disposable dev reset');
    await sibling.pool.query(`DELETE FROM ${schemaSql}.schema_migrations WHERE version = $1`, [unknownVersion]);
    const appliedCountAfterUnknown = await sibling.withTransaction(async client =>
      (await client.query(`SELECT count(*)::int AS n FROM ${schemaSql}.schema_migrations`)).rows[0].n);
    assert.equal(appliedCountAfterUnknown, appliedCountBeforeUnknown, '8a-2: the unknown row was restored (disposable sibling only)');
    scenario('8a-2: doctor fails real unknown-future dev state with the dev:reset remediation');

    // 8b. The OPERATIONAL channel still refuses: a store with the DEFAULT
    // guarded construction (disposableMigrations unset) migrates NOTHING
    // through the canonical migration-execution authority gate on this
    // pending (NOT_AUTHORIZED) transition, exactly as governed.
    let refusalError = null;
    const guardedOperationalStore = new PostgresRuntimeStore({
      connectionString: databaseUrl,
      schema: siblingSchema
    });
    try {
      const applied = await guardedOperationalStore.migrate();
      assert.equal(applied.length, 0, '8b: a guarded refusal applies nothing');
    } catch (error) {
      refusalError = error;
    } finally {
      await guardedOperationalStore.close();
    }
    assert.ok(refusalError, '8b: the canonical authority gate refuses the pending unauthorized transition');
    assert.equal(refusalError.code, 'MIGRATION_EXECUTION_AUTHORITY_REFUSED', '8b: refusal carries the migration authority code');
    assert.ok(refusalError instanceof MigrationExecutionAuthorityError, '8b: the canonical authority error class refuses');
    assert.match(String(refusalError.message), /NOT_AUTHORIZED/, '8b: the refusal names the authorization record state');
    const appliedAfter = await sibling.pool.query(`SELECT count(*)::int AS n FROM ${schemaSql}.schema_migrations`);
    assert.equal(appliedAfter.rows[0].n, appliedBefore.rows[0].n - 1, '8b: the refused transition applied NOTHING (no mutation)');
    scenario('8b: the canonical guarded migration gate still refuses an unauthorized pending transition (T10 factual)');

    // 8c. A store bound to a MISSING database in the same cluster renders the
    // doctor's disposable-development informational row (no failure).
    const missingUrl = databaseUrl.replace(/\/[^/?]*(\?.*)?$/, `/p6s2_missing_dev_${STAMP}`);
    const missingDoctor = await inspectDevelopmentEnvironment({
      storeFactory: () => new PostgresRuntimeStore({ connectionString: missingUrl, connectionTimeoutMs: 750, schema: siblingSchema }),
      env: {
        ...env,
        DATABASE_URL: missingUrl,
        POSTGRES_SCHEMA: siblingSchema,
        SESSION_SECRET: 'p6s2-doctor-missing-development-secret-0123456789abcdef'
      }
    });
    assert.ok(missingDoctor.checks.some(check =>
      check.status === 'info' && check.label === 'Disposable development database' &&
      /does not exist yet/.test(check.message)), '8c: the missing dev database renders informationally');
    assert.ok(missingDoctor.checks.some(check =>
      check.status === 'info' && check.label === 'admin account'), '8c: admin inspection is deferred informationally');
    scenario('8c: doctor reports a missing disposable development database informationally');
  } finally {
    try { await sibling.pool.query(`DROP SCHEMA IF EXISTS "${siblingSchema}" CASCADE`); } catch (_) {}
    try { await sibling.close(); } catch (_) {}
  }

    assertScenariosExecuted({
    label: 'p6-s2 readiness postgres test',
    assertions: assert.count(),
    scenarios: scenariosRun
  });
  console.log(`\nPASS: p6-s2 readiness PostgreSQL-native suites (${scenariosRun} scenarios, ${assert.count()} assertions)`);
}

function lastResponseIsDesigned(response) {
  if (response.statusCode !== 503 && response.statusCode !== 200) return false;
  const body = parse(response.body);
  return body.status !== undefined && body.alive === true && body.capacity !== undefined;
}

function scenario(label) {
  scenariosRun += 1;
  console.log(`  ok ${label}`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
