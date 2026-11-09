#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const {
  DEFAULT_BUNDLED_POSTGRES_PORT,
  DEFAULT_DATABASE_URL,
  MIN_ADMIN_PASSWORD_LENGTH,
  applyLocalEnv,
  bundledDatabaseUrl,
  developmentConfig,
  generateSessionSecret,
  renderLocalEnv,
  resolveDevelopmentDatabaseTarget,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writeLocalEnv
} = require('./dev-environment');
const { inspectDevelopmentEnvironment, packageManagerCheck, printChecks } = require('./dev-doctor');
const { validateEnvironment } = require('../runtime/environment-config-registry');
const {
  DEFAULT_OPENAI_MODEL,
  agentReadiness,
  ensureInitialAgent,
  promptProviderConfig,
  providerConfigFromEnvironment
} = require('./dev-agent-config');
// scripts/dev-database.js exports exactly the two zero-argument high-level
// lifecycle operations; see the COMPOSE-A export-surface assertions below.
// Its proof mechanics (compose file/runtime/process-launch/verification/
// client) are module-owned and intentionally NOT reachable for injection,
// so lifecycle ordering uses an isolated child-process harness below.
const { prepareAndMigrateDisposableDevelopmentDatabase } = require('./dev-database');
const { DEFAULT_DATABASE_URL: SETUP_DEFAULT_DATABASE_URL, createInitialAdmin } = require('./dev-setup');
const { parseArgs, resolvePasswordTarget, rotateUserPassword } = require('./admin-password');
const { parseArgs: parseSmokeArgs, runSmoke, SMOKE_OBJECTIVE } = require('./dev-smoke');
const devEnvironment = require('./dev-environment');
const {
  DEVELOPMENT_TARGET_DATABASE,
  DEVELOPMENT_TARGET_HOST,
  DEVELOPMENT_TARGET_SCHEMA,
  DevelopmentServiceTopologyError,
  DevelopmentTargetCollisionError,
  assertDevelopmentTargetUsable,
  assessBundledServiceTopologyGuard,
  assessDevelopmentTargetCollision,
  createGuardedDevelopmentStore,
  disposableDevelopmentTarget,
  formatTargetIdentity,
  resolveOperationalChannelAuthority
} = devEnvironment;

async function main() {
  assert.match(validateDatabaseUrl(''), /required/);
  assert.match(validateDatabaseUrl('https://example.test/db'), /postgres/i);
  assert.equal(validateDatabaseUrl('postgresql://user:pass@localhost/db'), null);
  assert.match(validateSessionSecret('short'), /32/);
  assert.match(validateSessionSecret('replace-with-at-least-32-random-characters'), /placeholder/);
  assert.equal(validateSessionSecret(generateSessionSecret()), null);
  assert.match(validateAdminPassword('short', { required: true }), new RegExp(String(MIN_ADMIN_PASSWORD_LENGTH)));
  assert.equal(validateAdminPassword('long-enough-development-password', { required: true }), null);
  assert.equal(safeErrorMessage(new Error('connect postgresql://user:secret@localhost/db failed')).includes('secret'), false);

  const defaultDatabaseTarget = resolveDevelopmentDatabaseTarget({});
  assert.deepEqual(defaultDatabaseTarget, {
    kind: 'bundled',
    databaseUrl: DEFAULT_DATABASE_URL,
    composePort: DEFAULT_BUNDLED_POSTGRES_PORT,
    source: 'default'
  });
  assert.equal(SETUP_DEFAULT_DATABASE_URL, DEFAULT_DATABASE_URL);
  assert.equal(developmentConfig({}).databaseUrl, DEFAULT_DATABASE_URL);
  const customBundledUrl = bundledDatabaseUrl(55432);
  assert.deepEqual(resolveDevelopmentDatabaseTarget({ TICKET_SYSTEM_POSTGRES_PORT: '55432' }), {
    kind: 'bundled',
    databaseUrl: customBundledUrl,
    composePort: 55432,
    source: 'bundled-port'
  });
  // CHANNEL-SPLIT-A (exact): EVERY explicitly supplied DATABASE_URL — external
  // or bundled-named — owns the operational target EXACTLY, byte for byte,
  // regardless of URL shape. An explicitly supplied bundled-looking URL must
  // not gain any compose-port rewrite: no localhost exception, no bundled
  // credentials exception, no bundled-database-name exception, and no
  // resemblance-to-default exception reconnects the channels.
  assert.deepEqual(resolveDevelopmentDatabaseTarget({ DATABASE_URL: customBundledUrl }), {
    kind: 'bundled',
    databaseUrl: customBundledUrl,
    composePort: DEFAULT_BUNDLED_POSTGRES_PORT,
    source: 'database-url'
  });
  const explicitBundledLikeDefault = resolveDevelopmentDatabaseTarget({
    DATABASE_URL: DEFAULT_DATABASE_URL,
    TICKET_SYSTEM_POSTGRES_PORT: '55432'
  });
  assert.deepEqual(explicitBundledLikeDefault, {
    kind: 'bundled',
    // BYTE-EXACT: TICKET_SYSTEM_POSTGRES_PORT (dev channel) NEVER rewrites the
    // explicit operational URL even when it names the bundled compose database.
    databaseUrl: DEFAULT_DATABASE_URL,
    // The bundled compose port stays the development-channel input only.
    composePort: 55432,
    source: 'database-url'
  });
  assert.equal(explicitBundledLikeDefault.databaseUrl, DEFAULT_DATABASE_URL,
    'the explicitly supplied operational URL is authoritative for the operational channel exactly');
  const externalDatabaseUrl = 'postgresql://external:test-only-password@db.example.test:6543/external';
  assert.deepEqual(resolveDevelopmentDatabaseTarget({ DATABASE_URL: externalDatabaseUrl }), {
    kind: 'external',
    databaseUrl: externalDatabaseUrl,
    composePort: DEFAULT_BUNDLED_POSTGRES_PORT,
    source: 'database-url'
  });

  // ── CHANNEL-SPLIT-A: the configuration channels are INDEPENDENT ──────────
  // An explicitly supplied operational DATABASE_URL owns the operational
  // target exactly; TICKET_SYSTEM_POSTGRES_PORT owns only the bundled
  // disposable-development compose port. The two may coexist; the port does
  // not alter or invalidate the operational URL and is never part of its
  // identity, and the operational URL does not reach the development target.
  const externalOperationalUrl = 'postgresql://user:secret@ops.example:5432/operational_db';
  const splitTarget = resolveDevelopmentDatabaseTarget({
    DATABASE_URL: externalOperationalUrl,
    TICKET_SYSTEM_POSTGRES_PORT: '55432'
  });
  assert.deepEqual(splitTarget, {
    kind: 'external',
    databaseUrl: externalOperationalUrl,
    composePort: 55432,
    source: 'database-url'
  }, 'an external operational DATABASE_URL and a custom bundled dev port are VALID together');
  // TSPP cannot change the explicit operational URL, and the operational URL
  // cannot change the development target.
  assert.equal(splitTarget.databaseUrl, externalOperationalUrl,
    'the custom bundled dev port never alters the explicit operational URL');
  const splitConfig = developmentConfig({
    DATABASE_URL: externalOperationalUrl,
    TICKET_SYSTEM_POSTGRES_PORT: '55432'
  });
  assert.equal(splitConfig.databaseUrl, externalOperationalUrl,
    'operational identity remains the external URL exactly');
  const splitDevTarget = disposableDevelopmentTarget({
    DATABASE_URL: externalOperationalUrl,
    TICKET_SYSTEM_POSTGRES_PORT: '55432'
  });
  assert.equal(splitDevTarget.databaseUrl,
    'postgresql://ticket_system:ticket_system@127.0.0.1:55432/ticket_system_dev',
    'the development target uses the custom bundled port and stays the fixed dev identity');
  assert.equal(splitDevTarget.host, DEVELOPMENT_TARGET_HOST);
  assert.equal(splitDevTarget.database, DEVELOPMENT_TARGET_DATABASE);
  assert.equal(splitDevTarget.schema, DEVELOPMENT_TARGET_SCHEMA);
  // POSTGRES_SCHEMA affects the operational channel only; the development
  // schema remains fixed.
  assert.deepEqual(
    disposableDevelopmentTarget({ DATABASE_URL: externalOperationalUrl, POSTGRES_SCHEMA: 'redirected_schema' }),
    disposableDevelopmentTarget({ DATABASE_URL: externalOperationalUrl })
  );
  const splitSchemaAssessment = assessDevelopmentTargetCollision({
    DATABASE_URL: externalOperationalUrl,
    TICKET_SYSTEM_POSTGRES_PORT: '55432',
    POSTGRES_SCHEMA: 'operational_schema'
  });
  assert.equal(splitSchemaAssessment.ok, true, 'the split-channel pair does not collide');
  assert.equal(splitSchemaAssessment.operational.host, 'ops.example');
  assert.equal(splitSchemaAssessment.operational.port, 5432);
  assert.equal(splitSchemaAssessment.operational.database, 'operational_db');
  assert.equal(splitSchemaAssessment.operational.schema, 'operational_schema',
    'POSTGRES_SCHEMA reaches the operational identity only');
  assert.equal(splitSchemaAssessment.development.port, 55432);
  assert.equal(splitSchemaAssessment.development.database, DEVELOPMENT_TARGET_DATABASE);
  // The channels also stay independent in the reverse direction: DATABASE_URL
  // (even a bundled-looking or external one) cannot rename the dev database
  // or schema; only the compose-owned port can move.
  assert.deepEqual(
    disposableDevelopmentTarget({
      DATABASE_URL: 'postgresql://ticket_system:other-cred@127.0.0.1:6541/ticket_system',
      POSTGRES_SCHEMA: 'other'
    }),
    disposableDevelopmentTarget({})
  );

  // TICKET_SYSTEM_POSTGRES_PORT — STRICT owner parity (configures the BUNDLED
  // development database). The real owner seam (resolveDevelopmentDatabaseTarget)
  // reads `String(env.TICKET_SYSTEM_POSTGRES_PORT || '').trim()` and requires
  // the WHOLE trimmed value to be decimal digits forming a safe integer within
  // [1, 65535]; it throws the canonical message otherwise. Surrounding
  // whitespace is consumed by the owner before the rule (' 5432 ' configures
  // port 5432) and a whitespace-only value is unset (the bundled default),
  // exactly like absence. The canonical registry (doctor context validates the
  // development settings) must agree with the owner on every value class — a
  // partial numeric prefix ('5432junk', '12abc') is never an accepted port for
  // either, and the suite fails if registry and owner drift.
  const TSPP_EXPECTED_MESSAGE = 'TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through 65535';
  const TSPP_CLASS_EXPECTATIONS = Object.freeze([
    // [configured value, accepted, expected owner composePort when accepted]
    ['5432', true, 5432],
    [' 5432 ', true, 5432],               // the owner trims before the digits rule
    ['05432', true, 5432],                // leading zero digits: same integer value
    ['65535', true, 65535],               // range boundary
    ['1', true, 1],                       // range boundary
    ['5432junk', false, null],            // trailing junk is never a partial prefix
    ['12abc', false, null],
    ['5432.5', false, null],              // non-integer decimal text
    ['+5432', false, null],               // sign notation the owner refuses
    ['-5432', false, null],
    ['0', false, null],                   // bundled ports start at 1
    ['65536', false, null],               // above the range
    ['9999999999999999999', false, null], // digits-only but not a safe integer
    ['junk', false, null],
    ['   ', true, null]                   // whitespace-only is UNSET: bundled default
  ]);
  for (const [value, shouldAccept, expectedPort] of TSPP_CLASS_EXPECTATIONS) {
    const configured = { TICKET_SYSTEM_POSTGRES_PORT: value };
    let ownerPort = null;
    try {
      ownerPort = resolveDevelopmentDatabaseTarget(configured).composePort;
    } catch (_) {
      ownerPort = null; // the owner throws → the value is refused
    }
    assert.equal(
      ownerPort !== null,
      shouldAccept,
      `the bundled owner accepts TICKET_SYSTEM_POSTGRES_PORT=${JSON.stringify(value)} exactly when declared`
    );
    const registryFailures = validateEnvironment(configured, { context: 'doctor' }).failures
      .filter((failure) => failure.name === 'TICKET_SYSTEM_POSTGRES_PORT');
    assert.equal(
      registryFailures.length === 0,
      shouldAccept,
      `the canonical registry and the bundled owner agree for TICKET_SYSTEM_POSTGRES_PORT=${JSON.stringify(value)}`
    );
    if (!shouldAccept) {
      assert.equal(registryFailures[0].code, 'invalid_port_range');
      assert.equal(
        registryFailures[0].message,
        TSPP_EXPECTED_MESSAGE,
        'the registry failure names the setting and renders no value'
      );
    } else if (expectedPort !== null) {
      assert.equal(
        ownerPort,
        expectedPort,
        `the bundled owner binds TICKET_SYSTEM_POSTGRES_PORT=${JSON.stringify(value)} as port ${expectedPort}`
      );
    }
  }
  // The owner throw and the registry failure are ONE canonical sentence; this
  // must fail if registry and owner drift.
  try {
    resolveDevelopmentDatabaseTarget({ TICKET_SYSTEM_POSTGRES_PORT: '5432junk' });
    assert.ok(false, 'the bundled owner must throw for a partial-prefix port value');
  } catch (error) {
    const registryFailure = validateEnvironment(
      {
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
        SESSION_SECRET: 'x'.repeat(64),
        TICKET_SYSTEM_POSTGRES_PORT: '5432junk'
      },
      { context: 'doctor' }
    ).failures.filter((failure) => failure.name === 'TICKET_SYSTEM_POSTGRES_PORT')[0];
    assert.ok(registryFailure, 'the canonical registry refuses the same partial-prefix port value');
    assert.equal(
      registryFailure.message,
      error.message,
      'registry failure text and owner throw text are one canonical sentence'
    );
  }
  // bundledDatabaseUrl — the owner's URL builder — holds the exact boundaries.
  assert.equal(bundledDatabaseUrl(1), 'postgresql://ticket_system:ticket_system@127.0.0.1:1/ticket_system');
  assert.equal(bundledDatabaseUrl(65535), 'postgresql://ticket_system:ticket_system@127.0.0.1:65535/ticket_system');
  assert.equal(
    bundledDatabaseUrl('05432'),
    'postgresql://ticket_system:ticket_system@127.0.0.1:5432/ticket_system'
  );
  for (const refused of [0, '0', -1, '-5432', 65536, '65536', '5432junk', '12abc', '5432.5', '9999999999999999999']) {
    assert.throws(
      () => bundledDatabaseUrl(refused),
      (error) => error.message === TSPP_EXPECTED_MESSAGE,
      `bundledDatabaseUrl(${JSON.stringify(refused)}) is refused with the canonical owner message`
    );
  }

  assert.equal(packageManagerCheck('pnpm/10.0.0 npm/? node/v24').status, 'fail');
  assert.deepEqual(packageManagerCheck('npm/11.0.0 node/v24'), { status: 'pass', label: 'npm', message: '11; supported script runner' });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-dev-env-'));
  try {
    const envPath = path.join(temporary, '.env.local');
    const values = {
      databaseUrl: 'postgresql://user:secret@localhost/db',
      postgresSchema: 'ticket_system',
      sessionSecret: 's'.repeat(40),
      adminBootstrapPassword: ''
    };
    writeLocalEnv(values, envPath);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.throws(() => writeLocalEnv(values, envPath), error => error && error.code === 'EEXIST');
    assert.deepEqual(dotenv.parse(renderLocalEnv(values)), {
      DATABASE_URL: values.databaseUrl,
      POSTGRES_SCHEMA: values.postgresSchema,
      SESSION_SECRET: values.sessionSecret
    });

    const explicit = { DATABASE_URL: 'postgresql://explicit:pass@localhost/explicit' };
    applyLocalEnv(explicit, envPath);
    assert.equal(explicit.DATABASE_URL, 'postgresql://explicit:pass@localhost/explicit');
    assert.equal(explicit.SESSION_SECRET, values.sessionSecret);

    const customBundled = {
      DATABASE_URL: DEFAULT_DATABASE_URL,
      TICKET_SYSTEM_POSTGRES_PORT: '55432'
    };
    applyLocalEnv(customBundled, path.join(temporary, 'absent.env'));
    // The explicit operational URL is byte-exact after normalization: the dev
    // port edits the disposable development target only, never the URL.
    assert.equal(customBundled.DATABASE_URL, DEFAULT_DATABASE_URL);
    assert.equal(customBundled.TICKET_SYSTEM_POSTGRES_PORT, '55432');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const baseEnv = {
    DATABASE_URL: 'postgresql://user:secret@localhost/db',
    POSTGRES_SCHEMA: 'ticket_system',
    SESSION_SECRET: 's'.repeat(40),
    WORKSPACE_ROOT: os.tmpdir(),
    ARTIFACT_ROOT: os.tmpdir(),
    npm_config_user_agent: 'pnpm/11.8.0 npm/? node/v24'
  };
  // P6-S2: the doctor reads the canonical migration facts
  // (`getMigrationStatus` plus the read-only observation) instead of the old
  // prepareRuntimePersistence() latch. This stub answers those calls with a
  // fully-current ledger derived from the canonical enumeration.
  function fullyCurrentStoreStub({ adminUser, agents, onClose }) {
    const { migrationFiles, migrationChecksum } = require('../persistence/postgres/store');
    const versions = migrationFiles();
    return {
      schema: 'ticket_system',
      async getMigrationStatus() {
        return {
          fullyApplied: true,
          checksumsValid: true,
          partial: false,
          currentVersion: Number(versions[versions.length - 1].slice(0, 3)),
          headVersion: Number(versions[versions.length - 1].slice(0, 3)),
          pendingMigrations: 0,
          unknownMigrations: 0
        };
      },
      async withTransaction(operation) {
        return operation({
          async query(sql) {
            if (sql.includes('current_database()')) return { rows: [{ name: 'stubdb' }] };
            if (sql.includes('pg_namespace')) return { rowCount: 1, rows: [] };
            if (sql.includes('to_regclass')) return { rows: [{ name: 'stub' }] };
            if (sql.includes('schema_migration_identities')) {
              return { rows: versions.map(version => ({ version, sha256: migrationChecksum(version) })) };
            }
            if (sql.includes('schema_migrations')) {
              return { rows: versions.map(version => ({ version })) };
            }
            return { rows: [], rowCount: 0 };
          }
        });
      },
      async getUserByUsername() { return adminUser; },
      async listConfiguredAgents() { return { agents, nextAfterId: null }; },
      async close() { if (onClose) onClose(); }
    };
  }
  let closed = false;
  const existingAdmin = {
    id: 7,
    username: 'admin',
    passwordHash: 'stored-hash',
    revision: 3,
    groupIds: [2, 4],
    profile: 'preserved'
  };
  const healthy = await inspectDevelopmentEnvironment({
    env: { ...baseEnv, ADMIN_BOOTSTRAP_PASSWORD: 'stale' },
    storeFactory: () => fullyCurrentStoreStub({
      adminUser: existingAdmin,
      agents: [{ provider: 'openai', model: 'test-model', apiKey: 'stored' }],
      onClose: () => { closed = true; }
    }),
    verifyPassword: async (_hash, candidate) => candidate === 'admin123'
  });
  assert.equal(healthy.ok, true, 'warnings must not turn a usable environment into a startup outage');
  assert.equal(closed, true);
  assert.equal(healthy.checks.some(check => check.label === 'ADMIN_BOOTSTRAP_PASSWORD'), false);
  const passwordWarning = healthy.checks.find(
    check => check.status === 'warn' && check.label === 'admin password'
  );
  assert.ok(passwordWarning);
  assert.match(passwordWarning.message, /predictable default/);
  assert.doesNotMatch(passwordWarning.message, /legacy|initial/i);
  const rendered = [];
  printChecks(healthy, { write(value) { rendered.push(value) } });
  assert.equal(rendered.join('').includes('stale'), false, 'doctor output must not expose secret values');
  const doctorMigrationRow = healthy.checks.find(check => check.label === 'PostgreSQL migrations');
  assert.ok(doctorMigrationRow, 'doctor renders one canonical migration-ledger row');
  assert.equal(doctorMigrationRow.status, 'pass', 'a fully-current ledger is reported CURRENT');
  assert.match(doctorMigrationRow.message, /current/, 'the CURRENT guidance states the ledger truth');
  assert.equal(
    developmentConfig({}).workspaceRoot,
    path.resolve(path.join(__dirname, '..'), 'workspace-root'),
    'the development workspace default is the one canonical default the server also uses'
  );

  // P6-S2 defect-B effect-root semantics inside the doctor: a path that exists
  // but is not a directory, and a missing path under an unusable parent, fail
  // the check with the honest corrected messages (never "usable").
  const { writablePathStatus } = require('./dev-environment');
  const pathCheckTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-path-'));
  try {
    const fileRoot = path.join(pathCheckTemporary, 'root-as-file');
    fs.writeFileSync(fileRoot, 'regular file');
    const fileStatus = writablePathStatus(fileRoot);
    assert.equal(fileStatus.ok, false, 'a regular file is not a usable effect root');
    assert.match(fileStatus.message, /not a directory/);

    const usableDir = path.join(pathCheckTemporary, 'usable-root');
    fs.mkdirSync(usableDir);
    assert.equal(writablePathStatus(usableDir).ok, true);
    assert.equal(writablePathStatus(path.join(usableDir, 'missing-root')).ok, true, 'creatable under a usable parent');
    assert.match(writablePathStatus(path.join(usableDir, 'missing-root')).message, /will be created/);

    const parentFile = path.join(pathCheckTemporary, 'parent-file');
    fs.writeFileSync(parentFile, 'regular file');
    const underFile = writablePathStatus(path.join(parentFile, 'child'));
    assert.equal(underFile.ok, false, 'a missing root under a file parent is unusable');
    assert.match(underFile.message, /not a directory/);
  } finally {
    fs.rmSync(pathCheckTemporary, { recursive: true, force: true });
  }
  console.log('  ok the doctor effect-root check uses the corrected directory-boundary semantics');

  const missingAdmin = await inspectDevelopmentEnvironment({
    env: { ...baseEnv, ADMIN_BOOTSTRAP_PASSWORD: 'long-enough-bootstrap-password' },
    storeFactory: () => fullyCurrentStoreStub({ adminUser: null, agents: [{ provider: 'ollama', model: 'test-model' }] })
  });
  assert.equal(missingAdmin.ok, false);
  assert.ok(missingAdmin.checks.some(check => check.status === 'fail' && check.label === 'admin account'));

  const missingAgents = await inspectDevelopmentEnvironment({
    env: baseEnv,
    storeFactory: () => fullyCurrentStoreStub({ adminUser: existingAdmin, agents: [] }),
    verifyPassword: async () => false
  });
  assert.equal(missingAgents.ok, false);
  assert.ok(missingAgents.checks.some(check => check.status === 'fail' && check.label === 'configured agents'));
  assert.equal(agentReadiness({ provider: 'openai', model: 'gpt-test' }, {}).ready, false);
  assert.equal(agentReadiness({ provider: 'openai', model: 'gpt-test' }, { OPENAI_API_KEY: 'set' }).ready, true);
  assert.equal(agentReadiness({ provider: 'ollama', model: 'local-test' }, {}).ready, true);
  assert.equal(providerConfigFromEnvironment({ OPENAI_API_KEY: 'key', OPENAI_MODEL: 'model' }).provider, 'openai');
  assert.equal(providerConfigFromEnvironment({ OLLAMA_MODEL: 'local' }).provider, 'ollama');

  const promptedOpenAI = await promptProviderConfig({
    env: { DEV_AGENT_PROVIDER: 'openai' },
    visiblePrompt: async (_message, { defaultValue }) => defaultValue,
    hiddenPrompt: async () => 'hidden-test-key'
  });
  assert.equal(promptedOpenAI.model, DEFAULT_OPENAI_MODEL);
  assert.equal(promptedOpenAI.apiKey, 'hidden-test-key');

  // ── BUNDLED-TOPOLOGY-A: shared bundled service port rule ─────────────────
  // The bundled local PostgreSQL SERVICE may host BOTH the operational
  // database and the disposable development database (different names, ONE
  // physical service). When the configured operational target is that bundled
  // service, the development Compose host port MUST equal the exact
  // operational DATABASE_URL port; an incompatible TICKET_SYSTEM_POSTGRES_PORT
  // refuses BEFORE any Compose/runtime/database contact and the explicit
  // operational URL stays byte-exact. This is deliberately SEPARATE from
  // COLLISION-A.
  const bundledOperationalUrl = 'postgresql://ticket_system:ticket_system@127.0.0.1:5432/ticket_system';
  const bundledAtDevDifferentPort = { DATABASE_URL: bundledOperationalUrl, TICKET_SYSTEM_POSTGRES_PORT: '55432' };
  const bundledTopologyAllowed = assessBundledServiceTopologyGuard({
    DATABASE_URL: bundledOperationalUrl
  });
  assert.equal(bundledTopologyAllowed.ok, true,
    'bundled operational URL at 5432 with TSPP unset: allowed (Compose port = operational port)');
  assert.equal(assessBundledServiceTopologyGuard({
    DATABASE_URL: bundledOperationalUrl,
    TICKET_SYSTEM_POSTGRES_PORT: '5432'
  }).ok, true,
    'bundled operational URL at 5432 with TSPP=5432: allowed');
  const bundledTopologyRefusal = assessBundledServiceTopologyGuard(bundledAtDevDifferentPort);
  assert.equal(bundledTopologyRefusal.ok, false,
    'bundled operational URL at 5432 with TSPP=55432: REFUSED');
  assert.equal(bundledTopologyRefusal.operationalPort, 5432);
  assert.equal(bundledTopologyRefusal.composePort, 55432);
  assert.match(bundledTopologyRefusal.reason, /bound to the same bundled local PostgreSQL service/);
  assert.match(bundledTopologyRefusal.reason, /exact operational DATABASE_URL unavailable/);
  assert.match(bundledTopologyRefusal.reason, /TICKET_SYSTEM_POSTGRES_PORT=5432/);
  assert.equal(bundledTopologyRefusal.reason.includes('test-only-password'), false, 'refusals stay credential-free');
  try {
    assertDevelopmentTargetUsable(bundledAtDevDifferentPort);
    assert.ok(false, 'the throwing guard composes the bundled-topology refusal');
  } catch (error) {
    assert.equal(error.name, 'DevelopmentServiceTopologyError');
    assert.equal(error.code, 'DEVELOPMENT_SERVICE_TOPOLOGY_REFUSED');
    assert.equal(error.message.includes('called before any runtime selection'), false);
    assert.equal(error instanceof DevelopmentTargetCollisionError, false,
      'the topology rule is a DISTINCT guard from COLLISION-A');
  }
  assert.equal(resolveDevelopmentDatabaseTarget(bundledAtDevDifferentPort).databaseUrl, bundledOperationalUrl,
    'the explicit operational URL remains BYTE-EXACT even when the topology rule refuses');
  assert.equal(assessBundledServiceTopologyGuard({
    DATABASE_URL: externalOperationalUrl,
    TICKET_SYSTEM_POSTGRES_PORT: '55432'
  }).ok, true, 'an EXTERNAL/non-bundled operational target allows an independent development Compose port');
  // Distinctness from COLLISION-A demonstrated in both directions: an
  // identity-colliding configuration raises the COLLISION class, and a
  // shared-service different-port configuration raises the TOPOLOGY class.
  try {
    assertDevelopmentTargetUsable({
      DATABASE_URL: 'postgresql://devopcred:test-only-password@127.0.0.1:5432/ticket_system_dev',
      POSTGRES_SCHEMA: 'ticket_system',
      TICKET_SYSTEM_POSTGRES_PORT: '5432'
    });
    assert.ok(false, 'identity collision must refuse');
  } catch (error) {
    assert.equal(error.name, 'DevelopmentTargetCollisionError',
      'the identity guard keeps its own class even when combined with a matching port');
  }
  // TSPP affects ONLY the development channel — the bundled topology rule is
  // the exception that keeps the shared service reachable.
  assert.deepEqual(
    disposableDevelopmentTarget(bundledAtDevDifferentPort),
    disposableDevelopmentTarget({ TICKET_SYSTEM_POSTGRES_PORT: '55432' }),
    'TSPP keeps selecting only the fixed development target identity'
  );

  // ── COMPOSE-A: no caller-replaceable proof mechanism on the production ───
  // disposable-authority path. The production lifecycle owner exports exactly
  // two ZERO-ARGUMENT operations; nothing else is exported to tests or
  // callers: no compose selector, no host-readiness verifier, no launch
  // implementation, no compose file pointer, no create/drop helper, and no
  // authority-bearing store constructor.
  const lifecycleRoot = path.join(__dirname, 'dev-database.js');
  const lifecycleSource = fs.readFileSync(lifecycleRoot, 'utf8');
  assert.deepEqual(
    Object.keys(require('./dev-database')).sort(),
    ['composeInvocationEnvironment', 'prepareAndMigrateDisposableDevelopmentDatabase', 'resetDisposableDevelopmentDatabase', 'trustedComposeRuntimeExecutablePath'],
    'the exported production surface is the two zero-argument lifecycle operations plus the two PURE non-authority test helpers (trusted-runtime classifier, Compose environment sanitizer)'
  );
  const devLifecycleSourceForExports = fs.readFileSync(path.join(__dirname, 'dev-database.js'), 'utf8');
  assert.doesNotMatch(devLifecycleSourceForExports, /\bmodule\.exports\s*=\s*\{[^}]*\b(spawn|runtime|composeFile|verifyDatabase|clientFactory|applyEnv)\b/,
    'the lifecycle owner exports no proof-mechanism seam of any kind');
  assert.equal(prepareAndMigrateDisposableDevelopmentDatabase.length, 0,
    'the prepare+migrate operation takes zero parameters — no proof mechanism can be supplied');
  assert.equal(require('./dev-database').resetDisposableDevelopmentDatabase.length, 0,
    'the reset operation takes zero parameters — no proof mechanism can be supplied');
  for (const forbiddenExport of [
    'COMPOSE_FILE',
    'COMPOSE_RUNTIMES',
    'commandSucceeded',
    'selectComposeRuntime',
    'startDevelopmentDatabase',
    'verifyConfiguredDatabase',
    'prepareDisposableDevelopmentDatabase',
    'migrateDisposableDevelopmentDatabase',
    'ensureDisposableDevelopmentDatabase',
    'destroyDisposableDevelopmentDatabase',
    'createDisposableDevelopmentStore',
    'createDevelopmentStore'
  ]) {
    assert.equal(forbiddenExport in require('./dev-database'), false,
      `the lifecycle owner exports no proof mechanics or authority surface (${forbiddenExport} is module-internal)`);
  }
  // Refusing arguments happens BEFORE any launch/verification/DB contact, so
  // the refusal itself is provably side-effect-free (offline, in-process).
  const attackerKit = {
    spawn() { throw new Error('a caller launch substitution must never be called'); },
    runtime: { command: 'fake', prefix: [], label: 'Fake Compose' },
    composeFile: '/attacker/fake-compose.yml',
    verifyDatabase: async () => { throw new Error('a caller verification substitution must never be called'); },
    clientFactory: () => { throw new Error('a caller client substitution must never be called'); },
    env: { TICKET_SYSTEM_POSTGRES_PORT: '55432' }
  };
  await assert.rejects(
    prepareAndMigrateDisposableDevelopmentDatabase(attackerKit),
    /prepareAndMigrateDisposableDevelopmentDatabase accepts no arguments/,
    'passing ANY argument to the prepare+migrate operation refuses before any contact'
  );
  await assert.rejects(
    require('./dev-database').resetDisposableDevelopmentDatabase(attackerKit),
    /resetDisposableDevelopmentDatabase accepts no arguments/,
    'passing ANY argument to the reset operation refuses before any contact'
  );
  assert.match(
    lifecycleSource,
    /if \(arguments\.length > 0\)[\s\S]{0,400}?accepts no arguments/,
    'both exported operations refuse arguments in the production source'
  );

  // ── P6-DEVEX-A: fixed repository-owned disposable development target ──────
  const expectedDevUrl = 'postgresql://ticket_system:ticket_system@127.0.0.1:5432/ticket_system_dev';
  assert.equal(DEVELOPMENT_TARGET_HOST, '127.0.0.1');
  assert.equal(DEVELOPMENT_TARGET_DATABASE, 'ticket_system_dev');
  assert.equal(DEVELOPMENT_TARGET_SCHEMA, 'ticket_system');
  assert.equal(disposableDevelopmentTarget({}).databaseUrl, expectedDevUrl);
  assert.equal(
    disposableDevelopmentTarget({ TICKET_SYSTEM_POSTGRES_PORT: '55432' }).databaseUrl,
    'postgresql://ticket_system:ticket_system@127.0.0.1:55432/ticket_system_dev'
  );
  // DEV-TARGET-A: NO environment input may redirect the fixed development
  // target — DATABASE_URL, POSTGRES_SCHEMA, and the whole PG* family are
  // inert here; only TICKET_SYSTEM_POSTGRES_PORT (through the bundled compose
  // owner) can move the port.
  assert.deepEqual(disposableDevelopmentTarget({
    DATABASE_URL: 'postgresql://redirector:test-only-password@ops.example:6544/redirected',
    POSTGRES_SCHEMA: 'redirected_schema',
    PGHOST: '10.9.8.7',
    PGPORT: '7777',
    PGDATABASE: 'redirected_db',
    PGUSER: 'redirector',
    PGPASSWORD: 'test-only-password'
  }), disposableDevelopmentTarget({}));
  for (const refused of ['0', '65536', '5432junk', '  ']) {
    if (refused === '  ') continue; // whitespace-only is unset (bounded default)
    assert.throws(() => disposableDevelopmentTarget({ TICKET_SYSTEM_POSTGRES_PORT: refused }),
      error => error.message === TSPP_EXPECTED_MESSAGE);
  }
  assert.throws(() => disposableDevelopmentTarget({ TICKET_SYSTEM_POSTGRES_PORT: '65536' }),
    error => error.message === TSPP_EXPECTED_MESSAGE);
  // DEV-DISPOSABLE-A: NO exported function can create a disposable-migration
  // store from env alone. The authority-bearing constructor is module-internal
  // to the verified lifecycle owner (scripts/dev-database.js) and reachable
  // ONLY through the compose-verified flow; this file offers the ordinary
  // GUARDED development seam, which carries no migration authority.
  assert.equal(typeof devEnvironment.createDevelopmentStore, 'undefined',
    'the former exported authority helper is gone');
  const devDbLifecycle = require('./dev-database');
  for (const forbidden of [
    'createDevelopmentStore',
    'createDisposableDevelopmentStore',
    'ensureDisposableDevelopmentDatabase',
    'destroyDisposableDevelopmentDatabase',
    'migrateDisposableDevelopmentDatabase'
  ]) {
    assert.equal(forbidden in devDbLifecycle, false,
      `the lifecycle owner never exports the authority surface ${forbidden}`);
  }
  assert.equal(typeof devDbLifecycle.prepareAndMigrateDisposableDevelopmentDatabase, 'function');
  assert.equal(typeof devDbLifecycle.resetDisposableDevelopmentDatabase, 'function');
  const devStoreProbe = createGuardedDevelopmentStore({});
  assert.equal(devStoreProbe.disposableMigrations, false, 'the development read/provisioning seam constructs a guarded (non-disposable) store');
  assert.equal(devStoreProbe.schema, DEVELOPMENT_TARGET_SCHEMA);
  assert.equal(devStoreProbe.connectionString, expectedDevUrl);
  {
    const redirected = createGuardedDevelopmentStore({
      DATABASE_URL: 'postgresql://redirector:test-only-password@ops.example:6544/redirected',
      POSTGRES_SCHEMA: 'redirected_schema'
    });
    assert.equal(redirected.connectionString, expectedDevUrl, 'DATABASE_URL cannot redirect the development seam');
    assert.equal(redirected.schema, DEVELOPMENT_TARGET_SCHEMA, 'POSTGRES_SCHEMA cannot redirect the development seam');
    await redirected.close();
  }
  await devStoreProbe.close();

  // DEV-COLLISION-A: the collision matrix. Deterministic, credential-free,
  // no DNS, `localhost` aliased to `127.0.0.1` only.
  const defaultAssessment = assessDevelopmentTargetCollision({});
  assert.equal(defaultAssessment.ok, true, 'the bundled operational default is not the disposable development identity');
  assert.equal(defaultAssessment.operational.database, 'ticket_system');
  assert.equal(defaultAssessment.development.database, DEVELOPMENT_TARGET_DATABASE);
  assert.equal(defaultAssessment.reason, null);
  const collidingUrl = 'postgresql://session-credential:test-only-password@127.0.0.1:5432/ticket_system_dev';
  const colliding = assessDevelopmentTargetCollision({
    DATABASE_URL: collidingUrl,
    POSTGRES_SCHEMA: 'ticket_system'
  });
  assert.equal(colliding.ok, false, 'operational identity == fixed development identity refuses');
  assert.match(colliding.reason, /identical to the/);
  assert.equal(colliding.reason.includes('test-only-password'), false, 'collision reasons never leak credentials');
  assert.equal(colliding.reason.includes('session-credential'), false, 'collision reasons never leak usernames');
  assert.equal(colliding.development.database, DEVELOPMENT_TARGET_DATABASE);
  assert.deepEqual(colliding.operational, {
    host: '127.0.0.1', port: 5432, database: 'ticket_system_dev', schema: 'ticket_system'
  });
  // localhost → 127.0.0.1 aliasing (deterministic; no DNS resolution).
  const collidingLocalhost = assessDevelopmentTargetCollision({
    DATABASE_URL: 'postgresql://u:test-only-password@localhost:5432/ticket_system_dev',
    POSTGRES_SCHEMA: 'ticket_system'
  });
  assert.equal(collidingLocalhost.ok, false, 'the localhost alias collides');
  assert.equal(collidingLocalhost.operational.host, '127.0.0.1');
  // Only ALL FOUR normalized fields equal collide.
  assert.equal(assessDevelopmentTargetCollision({
    DATABASE_URL: collidingUrl, POSTGRES_SCHEMA: 'other_schema'
  }).ok, true, 'schema difference keeps the identities distinct');
  assert.equal(assessDevelopmentTargetCollision({
    DATABASE_URL: 'postgresql://u:test-only-password@localhost:5433/ticket_system_dev', POSTGRES_SCHEMA: 'ticket_system'
  }).ok, true, 'port difference keeps the identities distinct');
  assert.equal(assessDevelopmentTargetCollision({
    DATABASE_URL: 'postgresql://u:test-only-password@db.internal.example:5432/ticket_system_dev', POSTGRES_SCHEMA: 'ticket_system'
  }).ok, true, 'host difference keeps the identities distinct');
  // Unreadable operational identity refuses fail-closed BEFORE any contact.
  const unreadable = assessDevelopmentTargetCollision({
    DATABASE_URL: 'postgresql://incomplete', TICKET_SYSTEM_POSTGRES_PORT: ''
  });
  assert.equal(unreadable.ok, false, 'an unreadable operational identity refuses');
  assert.match(unreadable.reason, /operational target identity could not be established/);
  for (const accessor of [assertDevelopmentTargetUsable]) {
    try {
      accessor({ DATABASE_URL: collidingUrl, POSTGRES_SCHEMA: 'ticket_system' });
      assert.ok(false, 'the throwing guard must refuse');
    } catch (error) {
      assert.ok(error instanceof DevelopmentTargetCollisionError);
      assert.equal(error.code, 'DEVELOPMENT_TARGET_REFUSED');
      assert.equal(error.message.includes('test-only-password'), false, 'refusals are credential-free');
    }
  }

  // CHANNEL-SPLIT-A collision pins (§11): the guard compares the EXACT
  // operational identity derived from the explicit DATABASE_URL against the
  // fixed dev identity — with no compose-port rewrite of the explicit URL.
  assert.equal(assessDevelopmentTargetCollision({
    DATABASE_URL: 'postgresql://ticket_system:test-only-password@127.0.0.1:5432/ticket_system',
    TICKET_SYSTEM_POSTGRES_PORT: '55432',
    POSTGRES_SCHEMA: 'ticket_system'
  }).ok, true,
    'an explicit bundled-default-shaped operational URL (port 5432, database ticket_system) does NOT collide; its port is authoritative and not rewritten to 55432');
  assert.equal(assessDevelopmentTargetCollision({
    DATABASE_URL: bundledDatabaseUrl(55432),
    TICKET_SYSTEM_POSTGRES_PORT: '55432',
    POSTGRES_SCHEMA: 'ticket_system'
  }).ok, true,
    'an explicit bundled-shaped URL whose port equals TSPP still does not collide: the database name keeps the channels apart');
  {
    const portedIdentityCollision = assessDevelopmentTargetCollision({
      DATABASE_URL: 'postgresql://opcred:test-only-password@127.0.0.1:55432/ticket_system_dev',
      TICKET_SYSTEM_POSTGRES_PORT: '55432',
      POSTGRES_SCHEMA: 'ticket_system'
    });
    assert.equal(portedIdentityCollision.ok, false,
      'an explicit operational URL at the dev port/database with the dev schema DOES collide');
    assert.deepEqual(portedIdentityCollision.operational, {
      host: '127.0.0.1', port: 55432, database: 'ticket_system_dev', schema: 'ticket_system'
    });
  }

  // ── Bundled-infrastructure lifecycle ownership (deterministic statics) ────
  //
  // Runtime-flow ordering/ownership is statically owned here and in
  // scripts/migration-execution-authority-test.js; the AFFIRMATIVE proof that
  // the ordinary supported local path works is the bounded REAL developer
  // smoke against real system Docker Compose (never fake executables).
  const devLifecycleSource = fs.readFileSync(path.join(__dirname, 'dev-database.js'), 'utf8');
  assert.ok(devLifecycleSource.includes("'compose.dev.yml'") &&
     devLifecycleSource.includes('const COMPOSE_FILE = path.join(ROOT'),
    'the lifecycle pins the repository-owned compose.dev.yml by repository path');
  const lifecycleFlowSource = devLifecycleSource.slice(devLifecycleSource.indexOf('async function startDevelopmentDatabase()'));
  const guardIndex = lifecycleFlowSource.indexOf('assertDevelopmentTargetUsable(process.env)');
  const selectionIndex = lifecycleFlowSource.indexOf('const selectedRuntime = selectComposeRuntime()');
  const probeDefinitionIndex = devLifecycleSource.indexOf("'compose', 'version'");
  const upContractIndex = devLifecycleSource.indexOf("'up', '-d', '--wait'");
  assert.ok(guardIndex > -1 && selectionIndex > -1 && probeDefinitionIndex > -1 && upContractIndex > -1,
    'the lifecycle has a collision guard, a trusted runtime selection, a local default engine probe, and a fixed start contract');
  assert.ok(guardIndex > -1 && guardIndex < selectionIndex,
    'a collision refuses BEFORE any runtime selection or infrastructure contact');
  // DEV-RUNTIME-A: deterministic trusted absolute runtime resolution — the
  // ambient executable PATH is never consulted; the launch always uses the
  // real absolute Docker binary from a validated trusted system prefix.
  assert.match(devLifecycleSource, /COMPOSE_TRUSTED_BIN_DIRECTORIES = Object\.freeze\(\[/,
    'trusted runtime candidate directories are code constants, not caller inputs');
  assert.match(devLifecycleSource, /trustedComposeRuntimeExecutablePath\(/,
    'candidates pass through the pure trust classifier before any launch');
  assert.doesNotMatch(devLifecycleSource, /process\.env\.PATH|fromPath|envPath|\['PATH'\]|"PATH"/,
    'the lifecycle never consults the ambient PATH for runtime resolution');
  assert.match(devLifecycleSource, /composeInvocationEnvironment\(process\.env\)/,
    'the Compose child environment is sanitized (runtime/context redirection neutralized)');

  // ── Doctor development-target semantics (deterministic, stub-driven) ─────
  function ledgerStoreStub({
    schema = 'ticket_system',
    status = null,
    observed = null,
    identities = undefined,
    adminUser = existingAdmin,
    agents = [],
    onProbeError = null,
    touchAdmin = false
  } = {}) {
    const { migrationFiles: files, migrationChecksum: checksumFn } = require('../persistence/postgres/store');
    const versions = files();
    const statusShape = status === null
      ? { fullyApplied: true, checksumsValid: true, partial: false, currentVersion: 99, headVersion: 99, pendingMigrations: 0, unknownMigrations: 0 }
      : status;
    const observedShape = observed === null
      ? { schemaExists: true, ledgerExists: true, appliedVersions: versions }
      : observed;
    return {
      schema,
      async getMigrationStatus() {
        if (onProbeError) throw onProbeError;
        return statusShape;
      },
      async withTransaction(operation) {
        return operation({
          async query(sql) {
            if (sql.includes('current_database()')) return { rows: [{ name: 'stubdb' }] };
            if (sql.includes('pg_namespace')) return { rowCount: observedShape.schemaExists ? 1 : 0, rows: [] };
            if (sql.includes('to_regclass')) return { rows: [{ name: observedShape.ledgerExists ? 'stub' : null }] };
            if (sql.includes('schema_migration_identities')) {
              return { rows: identities || versions.map(version => ({ version, sha256: checksumFn(version) })) };
            }
            if (sql.includes('schema_migrations')) {
              return { rows: observedShape.appliedVersions.map(version => ({ version })) };
            }
            return { rows: [], rowCount: 0 };
          }
        });
      },
      async getUserByUsername() {
        if (touchAdmin) throw new Error('admin must not be contacted');
        return adminUser;
      },
      async listConfiguredAgents() { return { agents, nextAfterId: null }; },
      async close() {}
    };
  }

  // BEHIND (head row absent, valid identities): informational auto-migrate.
  {
    const versions = require('../persistence/postgres/store').migrationFiles();
    const behind = await inspectDevelopmentEnvironment({
      env: baseEnv,
      storeFactory: () => ledgerStoreStub({
        status: { fullyApplied: false, checksumsValid: true, partial: false, currentVersion: 43, headVersion: 44, pendingMigrations: 1, unknownMigrations: 0 },
        observed: { schemaExists: true, ledgerExists: true, appliedVersions: versions.slice(0, -1) },
        identities: versions.slice(0, -1).map(version => ({ version, sha256: require('../persistence/postgres/store').migrationChecksum(version) })),
        agents: [{ provider: 'ollama', model: 'test-model' }]
      }),
      verifyPassword: async () => false
    });
    const rows = behind.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.equal(rows.length, 1, 'exactly one development ledger row');
    assert.equal(rows[0].status, 'info', 'a behind disposable development ledger is informational');
    assert.match(rows[0].message, /behind the canonical migration source by 1/);
    assert.match(rows[0].message, /auto-migrate/);
    assert.match(rows[0].message, /disposable/);
    assert.doesNotMatch(rows[0].message, /authorized/, 'the dev ledger row makes no authorization claim');
    assert.equal(behind.ok, true, 'behind dev ledger does not fail the doctor');
  }

  // UNINITIALIZED (no schema/ledger): informational ledger row; admin/agent
  // rows report the still-absent account/agent truth (setup needed).
  {
    const uninit = await inspectDevelopmentEnvironment({
      env: baseEnv,
      storeFactory: () => ledgerStoreStub({
        status: { fullyApplied: false, checksumsValid: false, partial: false, currentVersion: 0, headVersion: 44, pendingMigrations: 44, unknownMigrations: 0 },
        observed: { schemaExists: false, ledgerExists: false, appliedVersions: [] },
        identities: null,
        adminUser: null
      })
    });
    const rows = uninit.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.equal(rows[0].status, 'info');
    assert.match(rows[0].message, /provisions and auto-migrates/);
    assert.equal(uninit.ok, false, 'a present-but-uninitialized database still lacks the admin account and agents');
    const adminRows = uninit.checks.filter(check => check.label === 'admin account');
    assert.equal(adminRows[0].status, 'fail');
  }

  // MISSING development database (3D000 at probe): informational, no failure,
  // admin/agent inspection skipped (no store contact beyond the probe).
  {
    const missing = await inspectDevelopmentEnvironment({
      env: baseEnv,
      storeFactory: () => ledgerStoreStub({
        onProbeError: Object.assign(new Error('database "ticket_system_dev" does not exist'), { code: '3D000' }),
        touchAdmin: true
      })
    });
    assert.equal(missing.ok, true, 'a missing development database is informational');
    const infoRows = missing.checks.filter(check => check.label === 'Disposable development database');
    assert.equal(infoRows.length, 1);
    assert.match(infoRows[0].message, /does not exist yet/);
    assert.match(infoRows[0].message, /dev:setup|npm run dev|`npm run dev`/);
    assert.equal(missing.checks.filter(check => check.label === 'admin account' && check.status === 'info').length, 1);
  }

  // Unknown future migration → FAIL with exactly the dev:reset remediation.
  {
    const unknown = await inspectDevelopmentEnvironment({
      env: baseEnv,
      storeFactory: () => ledgerStoreStub({
        status: { fullyApplied: false, checksumsValid: false, partial: false, currentVersion: 44, headVersion: 44, pendingMigrations: 0, unknownMigrations: 1 }
      })
    });
    const rows = unknown.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.equal(rows[0].status, 'fail');
    assert.match(rows[0].message, /unknown future migrations/);
    assert.match(rows[0].message, /dev:reset/);
    assert.equal(unknown.ok, false);
  }

  // Applied-identity drift → FAIL with dev:reset remediation (partial state).
  {
    const versions = require('../persistence/postgres/store').migrationFiles();
    const drifted = await inspectDevelopmentEnvironment({
      env: baseEnv,
      storeFactory: () => ledgerStoreStub({
        identities: [...versions.map(version => ({ version, sha256: require('../persistence/postgres/store').migrationChecksum(version) })),
          { version: '099_stray_history.sql', sha256: '0'.repeat(64) }]
      })
    });
    const rows = drifted.checks.filter(check => check.label === 'PostgreSQL migrations');
    assert.equal(rows[0].status, 'fail');
    assert.match(rows[0].message, /dev:reset/);
    assert.equal(drifted.ok, false);
  }

  // Collision → FAIL before ANY development store contact.
  {
    let constructedStores = 0;
    const refusal = await inspectDevelopmentEnvironment({
      env: { ...baseEnv, DATABASE_URL: collidingUrl, POSTGRES_SCHEMA: 'ticket_system' },
      storeFactory() { constructedStores += 1; return ledgerStoreStub({}); }
    });
    assert.equal(constructedStores, 0, 'collision refusal performs no database contact');
    const rows = refusal.checks.filter(check => check.label === 'Development target collision');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'fail');
    assert.match(rows[0].message, /identical to the/);
    assert.equal(refusal.ok, false);
    const infoRows = refusal.checks.filter(check => check.status === 'info' && check.label.startsWith('Operational database'));
    assert.equal(infoRows.length, 1, 'exactly ONE informational operational identity row');
    assert.equal(infoRows[0].message.includes('test-only-password'), false, 'informational rows never carry credentials');
    assert.match(infoRows[0].message, /database ticket_system_dev/);
  }

  // Bundled-service port refusal (topology guard) → FAIL before ANY database
  // contact; the operational info row still renders credential-free.
  {
    let topologyStoreConstructions = 0;
    const topologyRefusal = await inspectDevelopmentEnvironment({
      env: {
        ...baseEnv,
        DATABASE_URL: 'postgresql://ticket_system:test-only-password@127.0.0.1:5432/ticket_system',
        TICKET_SYSTEM_POSTGRES_PORT: '55432',
        POSTGRES_SCHEMA: 'ticket_system'
      },
      storeFactory() { topologyStoreConstructions += 1; return ledgerStoreStub({}); }
    });
    assert.equal(topologyStoreConstructions, 0, 'topology refusal performs no database contact');
    const topologyRows = topologyRefusal.checks.filter(check => check.label === 'Bundled service port');
    assert.equal(topologyRows.length, 1, 'exactly one bundled-service-topology row');
    assert.equal(topologyRows[0].status, 'fail');
    assert.match(topologyRows[0].message, /same bundled local PostgreSQL service/);
    assert.match(topologyRows[0].message, /TICKET_SYSTEM_POSTGRES_PORT=5432/);
    assert.equal(topologyRefusal.ok, false);
    const infoRowsForTopology = topologyRefusal.checks.filter(
      check => check.status === 'info' && check.label.startsWith('Operational database')
    );
    assert.equal(infoRowsForTopology.length, 1, 'exactly ONE informational operational identity row on topology refusal');
    assert.equal(infoRowsForTopology[0].message.includes('test-only-password'), false);
  }

  // Healthy run rows: exactly one informational operational row, no collision.
  {
    const operationalRows = healthy.checks.filter(check => check.status === 'info' && check.label.startsWith('Operational database'));
    assert.equal(operationalRows.length, 1, 'one informational operational row on a healthy dev environment');
    assert.equal(operationalRows[0].message.includes('secret'), false, 'operational identity rows are credential-free');
    assert.ok(healthy.checks.some(check => check.label === 'Disposable development target' && check.status === 'pass'));
  }

  // ── npm run dev lifecycle ordering (static, order-sensitive) ─────────────
  const developmentStartupSource = fs.readFileSync(path.join(__dirname, 'dev.js'), 'utf8');
  const devLifecycleIndices = [
    'applyLocalEnv()',
    'prepareAndMigrateDisposableDevelopmentDatabase()',
    'await runDoctor()',
    'process.env.DATABASE_URL = target.databaseUrl;',
    'process.env.POSTGRES_SCHEMA = DEVELOPMENT_TARGET_SCHEMA',
    "require('../server')"
  ].map(token => developmentStartupSource.indexOf(token));
  assert.ok(devLifecycleIndices.every(index => index > -1), 'dev.js drives every required lifecycle step');
  assert.deepEqual(
    devLifecycleIndices,
    [...devLifecycleIndices].sort((a, b) => a - b),
    'dev.js lifecycle order: env → guard/provision/verified-migrate → doctor → fixed server env → server'
  );
  assert.match(developmentStartupSource, /prepareAndMigrateDisposableDevelopmentDatabase/,
    'dev startup migrates ONLY through the compose-verified lifecycle');
  assert.doesNotMatch(developmentStartupSource, /createDevelopmentStore|new PostgresRuntimeStore|disposableMigrations/,
    'dev never constructs or exposes an authority-bearing store itself');

  // dev:setup statics: all DB mutations flow through the fixed dev target.
  const setupSource = fs.readFileSync(path.join(__dirname, 'dev-setup.js'), 'utf8');
  assert.match(setupSource, /prepareAndMigrateDisposableDevelopmentDatabase\(/, 'dev:setup provisions and migrates through the shared verified lifecycle');
  assert.match(setupSource, /createGuardedDevelopmentStore\(/, 'dev:setup provisions through the guarded (non-authority) development seam');
  assert.doesNotMatch(setupSource, /new PostgresRuntimeStore\(/, 'dev:setup never constructs a store outside the fixed development seams');
  assert.doesNotMatch(setupSource, /disposableMigrations/, 'disposability stays declared only in the verified lifecycle owner');
  assert.match(setupSource, /Operational PostgreSQL URL/, 'setup names the operational semantics of DATABASE_URL honestly');

  // ── npm run dev:reset (bounded destructive authority) ────────────────────
  const { main: devResetMain } = require('./dev-reset');
  await assert.rejects(
    devResetMain(['node', 'dev:reset', '--database', 'other_db']),
    /does not accept arguments/,
    'dev:reset never accepts a database argument'
  );
  await assert.rejects(
    devResetMain(['node', 'dev:reset', 'some-target']),
    /does not accept arguments/,
    'dev:reset never accepts an arbitrary target argument'
  );
  {
    const devResetSource = fs.readFileSync(path.join(__dirname, 'dev-reset.js'), 'utf8');
    assert.doesNotMatch(devResetSource, /new PostgresRuntimeStore\(/, 'dev:reset constructs no store itself');
    assert.match(devResetSource, /resetDisposableDevelopmentDatabase\(/, 'the reset compose chain is owned by the verified lifecycle');
    assert.match(devResetSource, /await resetDisposableDevelopmentDatabase\(\)/,
      'dev:reset invokes the verified lifecycle with NO arguments — no identity input exists to pass');
    assert.doesNotMatch(devResetSource, /clientFactory|verifyDatabase|composeFile|applyEnv|\bspawn\b/,
      'dev:reset forwards no proof mechanics of any kind');
    assert.doesNotMatch(devResetSource, /ensureDisposableDevelopmentDatabase|destroyDisposableDevelopmentDatabase|createDisposableDevelopmentStore/,
      'dev:reset composes NO identity-bearing helper itself');
    // DEV-RESET-A is proven functionally by the isolated lifecycle harness
    // above (collision refusal with zero launches/contacts, and the bounded
    // destroy→recreate→migrate ordering through the real module-owned path);
    // no in-process invocation is possible because the exported lifecycle
    // accepts no arguments or seams to drive.
  }

  for (const file of ['dev-database.js', 'dev-setup.js', 'dev-doctor.js', 'dev-reset.js', 'postgres-migrate.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(
      source.includes(DEFAULT_DATABASE_URL),
      false,
      `${file} must consume the shared development database authority rather than duplicate its URL`
    );
  }
  assert.match(
    fs.readFileSync(path.join(__dirname, 'dev-doctor.js'), 'utf8'),
    /developmentConfig\(env\)/,
    'dev:doctor must resolve its database through the shared development configuration'
  );
  const migrationSource = fs.readFileSync(path.join(__dirname, 'postgres-migrate.js'), 'utf8');
  assert.match(migrationSource, /developmentConfig\(process\.env\)/);
  assert.doesNotMatch(migrationSource, /process\.env\.DATABASE_URL/);
  assert.ok(
    developmentStartupSource.indexOf('applyLocalEnv()') < developmentStartupSource.indexOf("require('../server')"),
    'dev startup must normalize DATABASE_URL before loading the server that consumes it directly'
  );

  let bootstrapCalls = 0;
  const created = await createInitialAdmin({
    store: {
      async getUserByUsername() { return null; },
      async ensureBootstrapAccess(value) {
        bootstrapCalls += 1;
        assert.equal(value.changedBy, 'dev-setup');
        assert.equal(value.passwordHash, 'new-hash');
        return { adminUser: { id: 1, username: 'admin' } };
      }
    },
    password: 'long-enough-password',
    hashPassword: async () => 'new-hash'
  });
  assert.equal(created.created, true);
  assert.equal(bootstrapCalls, 1);

  const preserved = await createInitialAdmin({
    store: { async getUserByUsername() { return existingAdmin; } },
    password: 'long-enough-password',
    hashPassword: async () => { throw new Error('must not hash'); }
  });
  assert.equal(preserved.created, false);

  let createdAgentInput;
  const initialAgent = await ensureInitialAgent({
    store: {
      async listConfiguredAgents() { return { agents: [], nextAfterId: null }; },
      async listGroups() { return { groups: [{ id: 9, name: 'Agent Support' }] }; },
      async createConfiguredAgent(input) {
        createdAgentInput = input;
        return { agent: { id: 11, ...input.value, groupIds: input.groupIds } };
      }
    },
    env: { OLLAMA_MODEL: 'local-test-model' },
    interactive: false
  });
  assert.equal(initialAgent.created, true);
  assert.equal(createdAgentInput.changedBy, 'dev-setup');
  assert.deepEqual(createdAgentInput.groupIds, [9]);
  assert.equal(createdAgentInput.value.provider, 'ollama');
  assert.equal(createdAgentInput.value.model, 'local-test-model');

  const existingAgent = { id: 12, name: 'Existing', provider: 'openai', model: 'existing-model', apiKey: 'stored' };
  const preservedAgent = await ensureInitialAgent({
    store: {
      async listConfiguredAgents() { return { agents: [existingAgent], nextAfterId: null }; },
      async listGroups() { throw new Error('must not inspect groups'); },
      async createConfiguredAgent() { throw new Error('must not create'); }
    },
    env: {},
    interactive: false
  });
  assert.equal(preservedAgent.created, false);
  assert.equal(preservedAgent.agent, existingAgent);

  let repairInput;
  const repairedCatalog = await ensureInitialAgent({
    store: {
      async listConfiguredAgents() {
        return { agents: [{ id: 13, name: 'Developer Agent', provider: 'openai', model: '' }], nextAfterId: null };
      },
      async listGroups() { return { groups: [{ id: 9, name: 'Agent Support' }] }; },
      async createConfiguredAgent(input) {
        repairInput = input;
        return { agent: { id: 14, ...input.value, groupIds: input.groupIds } };
      }
    },
    env: { OLLAMA_MODEL: 'repair-model' },
    interactive: false
  });
  assert.equal(repairedCatalog.created, true);
  assert.equal(repairInput.value.name, 'Developer Agent 2');
  assert.equal(repairInput.value.provider, 'ollama');

  await assert.rejects(
    ensureInitialAgent({
      store: { async listConfiguredAgents() { return { agents: [], nextAfterId: null }; } },
      env: {},
      interactive: false
    }),
    /No runnable configured agent exists/
  );

  let update;
  const rotated = await rotateUserPassword({
    store: {
      async getUserByUsername(username) {
        assert.equal(username, 'admin');
        return existingAdmin;
      },
      async updateUser(value) {
        update = value;
        return { user: { ...value.value, revision: 4 } };
      }
    },
    username: 'admin',
    password: 'another-secure-password',
    hashPassword: async () => 'rotated-hash'
  });
  assert.equal(rotated.passwordHash, 'rotated-hash');
  assert.equal(update.expectedRevision, 3);
  assert.deepEqual(update.groupIds, [2, 4]);
  assert.equal(update.value.profile, 'preserved');
  assert.equal(update.changedBy, 'admin-password-cli');
  assert.throws(() => parseArgs(['--password', 'visible-secret']), /cannot be passed/);
  assert.deepEqual(parseArgs(['--username', 'operator']), { help: false, username: 'operator', operational: false });
  assert.deepEqual(parseArgs(['--', '--username', 'operator']), { help: false, username: 'operator', operational: false });

  // ── ADMIN-PASSWORD-DEVEX: exactly two target selectors, no caller-selectable
  // database identity. Deterministic coverage of the target-resolution seam;
  // non-TTY harnesses cannot drive the secure prompt, so identity selection,
  // credential-free rendering, and fail-closed argument handling are proven
  // here, and the CLI live behavior is proven against the running databases
  // (development passes the integrity gate; operational refuses while the
  // operational migration ledger is behind the source head).
  const pwdHostileEnv = {
    DATABASE_URL: 'postgresql://opsuser:opspw@10.0.0.5:6500/ops_ticket_system',
    POSTGRES_SCHEMA: 'ops_schema',
    PGHOST: 'pg-evil-host',
    PGDATABASE: 'pg-evil-database',
    PGPORT: '6400',
    PGPASSWORD: 'pg-evil-password'
  };

  // ADMIN-PASSWORD-DEV-A + ADMIN-PASSWORD-CHANNEL-A: the default target is the
  // fixed code-owned disposable development identity; DATABASE_URL,
  // POSTGRES_SCHEMA, and PG* libpq variables cannot redirect it. The ONLY
  // environmental input remains the compose-owned TICKET_SYSTEM_POSTGRES_PORT,
  // exactly like the rest of the dev family.
  const devPasswordTarget = resolvePasswordTarget({ operational: false, env: pwdHostileEnv });
  assert.equal(devPasswordTarget.channel, 'development');
  assert.deepEqual(devPasswordTarget.identity, {
    host: DEVELOPMENT_TARGET_HOST,
    port: DEFAULT_BUNDLED_POSTGRES_PORT,
    database: DEVELOPMENT_TARGET_DATABASE,
    schema: DEVELOPMENT_TARGET_SCHEMA
  });
  assert.equal(devPasswordTarget.schema, 'ticket_system');
  assert.equal(devPasswordTarget.connectionString, disposableDevelopmentTarget(pwdHostileEnv).databaseUrl);

  // ADMIN-PASSWORD-SECRET-A: rendered target identity is credential-free for
  // both channels (no URL, no password material of any shape).
  const renderedDevPasswordIdentity = formatTargetIdentity(devPasswordTarget.identity);
  assert.doesNotMatch(renderedDevPasswordIdentity, /postgresql/);
  assert.doesNotMatch(renderedDevPasswordIdentity, /opspw/);

  // OPERATIONAL-AUTHORITY-A (F1 correction): exactly ONE pre-normalization
  // authority decision owns the operational channel — both its authorization
  // and its exact connection target come from the SAME frozen decision, and no
  // source is re-read or re-normalized after the decision. The decisive cases:
  //   1. explicitly blank env DATABASE_URL + configured .env.local → REFUSED;
  //   2. explicitly whitespace env DATABASE_URL + configured .env.local → REFUSED;
  //   3. env property absent + nonempty .env.local URL → the exact file URL;
  //   4. nonempty explicit env URL + different file URL → the exact env URL;
  //   5. the resolved target's identity AND connection string both derive from
  //      that one decision object;
  //   6. an explicitly blank POSTGRES_SCHEMA resolves to the canonical
  //      operational default at decision time (canonical precedence; the file's
  //      schema value never resurfaces after authorization);
  //   7. no explicit configuration anywhere → REFUSED;
  //   8. the ordinary development default is untouched (covered above with
  //      DEV-A/CHANNEL-A) and the T10 operational 043/database-vs-source 044
  //      refusal stays live behavior through prepareRuntimePersistence.
  const authorityFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-authority-f1-'));
  try {
    const authorityFileFixture = path.join(authorityFixtureDir, '.env.local');
    fs.writeFileSync(authorityFileFixture, [
      'DATABASE_URL=postgresql://fileuser:filepw@192.0.2.9:7200/file_ticket_system',
      'POSTGRES_SCHEMA=file_schema',
      ''
    ].join('\n'));

    const blankEnvAuthority = resolveOperationalChannelAuthority(
      { DATABASE_URL: '' }, { localEnvFile: authorityFileFixture });
    assert.equal(blankEnvAuthority.authorized, false,
      'an explicitly blank env DATABASE_URL must not authorize the operational channel');
    assert.match(blankEnvAuthority.reason, /explicitly present but empty/);

    const whitespaceEnvAuthority = resolveOperationalChannelAuthority(
      { DATABASE_URL: '   ' }, { localEnvFile: authorityFileFixture });
    assert.equal(whitespaceEnvAuthority.authorized, false,
      'a whitespace-only env DATABASE_URL must not authorize the operational channel');

    const missingEverythingAuthority = resolveOperationalChannelAuthority(
      {}, { localEnvFile: path.join(authorityFixtureDir, 'does-not-exist.env') });
    assert.equal(missingEverythingAuthority.authorized, false,
      'the operational channel requires an explicitly configured DATABASE_URL somewhere');

    const fileAuthority = resolveOperationalChannelAuthority(
      {}, { localEnvFile: authorityFileFixture });
    assert.equal(fileAuthority.authorized, true);
    assert.equal(fileAuthority.source, 'env-file');
    assert.equal(fileAuthority.databaseUrl, 'postgresql://fileuser:filepw@192.0.2.9:7200/file_ticket_system',
      'an env-absent DATABASE_URL selects the exact .env.local URL');
    assert.equal(fileAuthority.postgresSchema, 'file_schema',
      'the file schema participates only through the same canonical precedence snapshot');

    const envAuthority = resolveOperationalChannelAuthority(pwdHostileEnv, { localEnvFile: authorityFileFixture });
    assert.equal(envAuthority.authorized, true);
    assert.equal(envAuthority.source, 'environment');
    assert.equal(envAuthority.databaseUrl, pwdHostileEnv.DATABASE_URL,
      'an explicit nonempty env DATABASE_URL owns the exact operational URL');
    assert.equal(envAuthority.postgresSchema, 'ops_schema',
      'the explicit process property owns the operational schema');

    const blankSchemaAuthority = resolveOperationalChannelAuthority(
      { DATABASE_URL: 'postgresql://u:p@10.0.0.5:6500/ops_ticket_system', POSTGRES_SCHEMA: '' },
      { localEnvFile: authorityFileFixture });
    assert.equal(blankSchemaAuthority.postgresSchema, 'ticket_system',
      'an explicitly blank POSTGRES_SCHEMA is the canonical operational default at decision time');

    // One decision supplies identity AND the exact connection string.
    const operationalPasswordTarget = resolvePasswordTarget({ operational: true, authority: envAuthority });
    assert.equal(operationalPasswordTarget.channel, 'operational');
    assert.deepEqual(operationalPasswordTarget.identity, {
      host: '10.0.0.5',
      port: 6500,
      database: 'ops_ticket_system',
      schema: 'ops_schema'
    });
    assert.equal(operationalPasswordTarget.connectionString, envAuthority.databaseUrl,
      '--operational must preserve the exact configured operational URL from the SAME authority decision');
    assert.equal(operationalPasswordTarget.schema, envAuthority.postgresSchema,
      'the operational schema comes from the same authority decision');
    const filePasswordTarget = resolvePasswordTarget({ operational: true, authority: fileAuthority });
    assert.equal(filePasswordTarget.connectionString, fileAuthority.databaseUrl);
    assert.equal(filePasswordTarget.schema, fileAuthority.postgresSchema);
    assert.throws(() => resolvePasswordTarget({ operational: true }),
      /pre-normalization authority decision/,
      'operational resolution must not bypass the single authority decision');
    const renderedOperationalPasswordIdentity = formatTargetIdentity(operationalPasswordTarget.identity);
    assert.doesNotMatch(renderedOperationalPasswordIdentity, /postgresql/);
    assert.doesNotMatch(renderedOperationalPasswordIdentity, /opspw/);
  } finally {
    fs.rmSync(authorityFixtureDir, { recursive: true, force: true });
  }

  // ADMIN-PASSWORD-ARGS-A: unknown or conflicting selectors fail closed; no
  // arbitrary target flag exists (--database-url/--host/--database/--schema).
  assert.deepEqual(parseArgs(['--operational']), { help: false, username: 'admin', operational: true });
  assert.throws(() => parseArgs(['--operational', '--operational']), /already provided/);
  assert.throws(() => parseArgs(['--username', 'a', '--username', 'b']), /already provided/);
  assert.throws(() => parseArgs(['--username', '--operational']), /--username requires a value/);
  assert.throws(() => parseArgs(['--database-url', 'postgresql://evil/od']), /Unknown argument/);
  assert.throws(() => parseArgs(['--host', 'evil.example.invalid']), /Unknown argument/);
  assert.throws(() => parseArgs(['--database', 'evil']), /Unknown argument/);
  assert.throws(() => parseArgs(['--schema', 'evil']), /Unknown argument/);

  // ADMIN-PASSWORD-AUDIT-A source anchor: the CLI reaches PostgreSQL only
  // through the PostgresRuntimeStore (integrity gate then audited
  // store.updateUser); it contains no direct SQL mutation of user rows.
  const adminPasswordSource = fs.readFileSync(path.join(__dirname, 'admin-password.js'), 'utf8');
  assert.match(adminPasswordSource, /store\.updateUser\(/,
    'the password CLI must rotate through the audited repository owner');
  assert.match(adminPasswordSource, /prepareRuntimePersistence\(\)/,
    'both channels must pass the runtime-integrity gate before any user lookup');
  assert.match(adminPasswordSource, /assertDevelopmentTargetUsable\(/,
    'the default target must reuse the dev-family guarded development target owner');
  assert.match(adminPasswordSource, /new PostgresRuntimeStore\(/,
    'the password CLI owns exactly one store construction from the resolved target');
  assert.doesNotMatch(adminPasswordSource, /\b(query|exec)\s*\(/,
    'the password CLI must not mutate user rows with direct SQL');
  assert.match(adminPasswordSource, /resolveOperationalChannelAuthority\(\)/,
    'operational mode must be authorized from and resolved through the ONE pre-normalization authority decision');
  assert.match(adminPasswordSource, /authority\.databaseUrl/,
    'the operational connection string must come from the same authority decision');
  assert.doesNotMatch(adminPasswordSource, /operationalChannelConfigured/,
    'the old two-source gate must be superseded by the single authority decision');
  assert.throws(() => parseSmokeArgs(['--password', 'visible-secret']), /cannot be passed/);


  let smokeTicketCreated = false;
  const smokeOutput = [];
  const smokeResult = await runSmoke({
    options: parseSmokeArgs(['--timeout-ms', '1000']),
    env: { DEV_SMOKE_PASSWORD: 'hidden-test-password' },
    output: { write(value) { smokeOutput.push(value); } },
    sleep: async () => {},
    request: async (method, url, requestOptions = {}) => {
      if (url.endsWith('/health')) {
        assert.equal(method, 'GET');
        return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', ready: true }) };
      }
      if (url.endsWith('/login')) {
        assert.equal(method, 'POST');
        assert.match(requestOptions.body, /username=admin/);
        assert.match(requestOptions.body, /password=hidden-test-password/);
        return { status: 302, headers: { 'set-cookie': ['sessionId=test-cookie; Path=/'] }, body: '' };
      }
      if (url.includes('/api/configured-agents/resolve')) {
        return { status: 200, headers: {}, body: JSON.stringify({ agent: { id: 5, name: 'Developer Agent' } }) };
      }
      if (url.endsWith('/tickets') && method === 'POST') {
        assert.equal(new URLSearchParams(requestOptions.body).get('objective'), SMOKE_OBJECTIVE);
        smokeTicketCreated = true;
        return { status: 302, headers: {}, body: '' };
      }
      if (url.includes('/api/tickets/3/runtime')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            ticket: { id: 3, objective: SMOKE_OBJECTIVE, status: 'completed' },
            latestRun: { id: 4, status: 'completed' }
          })
        };
      }
      if (url.includes('/api/workspace/list')) {
        return { status: 200, headers: {}, body: JSON.stringify({ entries: [] }) };
      }
      if (url.endsWith('/api/tickets')) {
        const tickets = smokeTicketCreated
          ? [{ id: 3, objective: SMOKE_OBJECTIVE }]
          : [{ id: 2, objective: 'existing' }];
        return { status: 200, headers: {}, body: JSON.stringify({ tickets }) };
      }
      throw new Error('Unexpected smoke request: ' + method + ' ' + url);
    }
  });
  assert.equal(smokeResult.workspaceVerified, true);
  assert.match(smokeOutput.join(''), /ticket #3, run #4/);

  const packageJson = require('../package.json');
  assert.match(packageJson.scripts.dev, /scripts\/dev\.js$/);
  assert.match(packageJson.scripts['dev:db'], /scripts\/dev-database\.js$/);
  assert.match(packageJson.scripts['dev:smoke'], /scripts\/dev-smoke\.js$/);
  assert.match(packageJson.scripts['dev:setup'], /scripts\/dev-setup\.js$/);
  assert.match(packageJson.scripts['dev:doctor'], /scripts\/dev-doctor\.js$/);
  assert.match(packageJson.scripts['dev:reset'], /scripts\/dev-reset\.js$/, 'dev:reset owns the bounded destructive development reset');
  assert.match(packageJson.scripts['admin:password'], /scripts\/admin-password\.js$/);

  console.log('PASS: development setup is non-destructive, diagnosable, and uses audited credential updates');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
