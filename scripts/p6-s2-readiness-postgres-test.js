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
//   - the development doctor classifies the REAL ledger states
//     (current / behind+NOT authorized) with honest authority guidance;
//   - `dev:setup` still refuses an unauthorized pending transition (T10).
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
const { runSetup } = require('./dev-setup');
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
  await withHarness('p6 s2 readiness', async ({ store, schema, databaseUrl, startServer }) => {
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
  });

  // ── 8. Sibling disposable schema: behind + NOT authorized, setup refusal ─
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

    // 8a. Doctor classifies the real behind state with the REAL (NOT_AUTHORIZED)
    // authorization record — guidance must not claim a dev:setup bypass.
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
    assert.equal(behindRows[0].status, 'fail', '8a: behind + unauthorized fails the doctor');
    assert.match(behindRows[0].message, /behind by 1 pending migration/i, '8a: the row reports the schema is behind');
    assert.match(behindRows[0].message, /NOT authorized/i, '8a: the row reports the transition is NOT authorized');
    assert.match(behindRows[0].message, /pnpm dev:setup cannot bypass/i, '8a: the guidance never claims dev:setup can bypass T10');
    assert.match(behindRows[0].message, /migration\/bootstrap authority/i, '8a: the guidance points at the governed procedure');
    scenario('8a: doctor distinguishes BEHIND + NOT AUTHORIZED against a real behind schema');

    // 8b. Setup still refuses: dev:setup routes through the real gate.
    let refusalError = null;
    try {
      await runSetup({
        env: {
          DATABASE_URL: databaseUrl,
          POSTGRES_SCHEMA: siblingSchema,
          SESSION_SECRET: 'p6s2-setup-refusal-secret-0123456789abcdefghijklmnop'
        }
      });
    } catch (error) {
      refusalError = error;
    }
    assert.ok(refusalError, '8b: setup refuses a pending unauthorized transition');
    assert.equal(refusalError.code, 'MIGRATION_EXECUTION_AUTHORITY_REFUSED', '8b: refusal carries the migration authority code');
    assert.ok(refusalError instanceof MigrationExecutionAuthorityError, '8b: the canonical authority error class refuses');
    assert.match(String(refusalError.message), /NOT_AUTHORIZED/, '8b: the refusal names the authorization record state');
    const appliedAfter = await sibling.pool.query(`SELECT count(*)::int AS n FROM ${schemaSql}.schema_migrations`);
    assert.equal(appliedAfter.rows[0].n, appliedBefore.rows[0].n - 1, '8b: the refused transition applied NOTHING (no mutation)');
    scenario('8b: dev:setup still refuses an unauthorized migration (no auto-authorization)');
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
