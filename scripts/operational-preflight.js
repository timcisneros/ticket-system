#!/usr/bin/env node
'use strict';

// OP-PREFLIGHT-A: the operational deployment preflight.
//
// The development doctor (`scripts/dev-doctor.js`) is DEVELOPMENT-ONLY by
// design: it diagnoses the fixed disposable development database and never
// contacts operational state, so it cannot be the operational deployment
// validation. This script composes the
// repository's EXISTING canonical owners into the smallest read-only
// operational preflight surface. It performs NO mutation, applies NO migration,
// composes NO authorization, and offers no remediation or write surface:
//
//   - configuration validity comes from the canonical executable registry
//     (`runtime/environment-config-registry.js` validateEnvironment, context
//     `boot` — the same gate the server itself fails closed on);
//   - the exact operational connection channel comes from the ONE
//     pre-normalization authority decision (`resolveOperationalChannelAuthority`),
//     and the resolved identity is rendered credential-free BEFORE any contact;
//   - operational database reachability, the migration ledger/identity
//     compatibility facts, and the T10 runtime-integrity gate come from
//     `PostgresRuntimeStore.getMigrationStatus()` and
//     `prepareRuntimePersistence()` inside single READ ONLY transactions
//     (identical to what server startup refuses on);
//   - effect-root usability comes from the single canonical directory-boundary
//     walk (`runtime/health-readiness.js` effectRootReadiness), resolved under
//     the current working directory;
//   - configured-agent/provider readiness is an explicit READ-ONLY observation
//     of the same catalog the runtime uses (informational; never a readiness
//     or deployment decision of its own).
//
// A behind/non-compatible operational ledger REFUSES with the canonical
// classification and bound facts: starting a server against that ledger is
// refused anyway, so the preflight must not declare it viable. Migration
// roll-out itself remains the separately T10-guarded `pnpm db:migrate`
// command, which is a migration command — not an observation command.

const path = require('path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  formatTargetIdentity,
  operationalIdentityFrom,
  resolveOperationalChannelAuthority,
  validateDatabaseUrl
} = require('./dev-environment');
const {
  classifyMigrationStatus,
  effectRootReadiness
} = require('../runtime/health-readiness');
const { validateEnvironment } = require('../runtime/environment-config-registry');

const OPERATOR_GUIDE_DEFAULT_WORKSPACE_ROOT = 'workspace-root';
const CANONICAL_ARTIFACT_ROOT_DEFAULT = '.local-artifacts';

function preflightNote(message) {
  return `OPERATIONAL_PREFLIGHT: ${message}`;
}

// Read-only observation of the configured agents in the operational schema.
// One SELECT; refuses nothing; a failure degrades to an honest notice rather
// than inventing a readiness verdict.
async function observeConfiguredAgents(store) {
  const client = await store.pool.connect();
  try {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${store.table('configured_agents')}`);
    return { observed: true, count: result.rows[0].n };
  } finally {
    client.release();
  }
}

async function runOperationalPreflight({ env = process.env, cwd = process.cwd(), localEnvFile } = {}) {
  const lines = [];
  const facts = {
    key: 'operational-preflight',
    ok: true,
    channel: null,
    identity: null,
    configuration: null,
    effectRoots: null,
    migration: null,
    migrationStatus: null,
    configuredAgents: null
  };
  const refuse = reason => {
    facts.ok = false;
    return { ok: false, facts, lines, reason };
  };

  // 1. ONE pre-normalization authority decision (F1): the authorization and
  //    the exact connection target come from the same frozen object. Nothing
  //    below re-reads or re-normalizes another source for the target.
  //    `localEnvFile` is a pure injection seam for deterministic self-tests
  //    (identical to loadLocalEnvFile's filePath parameter); ordinary callers
  //    always use the repository .env.local.
  const authorityOptions = localEnvFile === undefined ? {} : { localEnvFile };
  const authority = resolveOperationalChannelAuthority(env, authorityOptions);
  facts.channel = authority.authorized ? authority.source : 'unauthorized';
  if (!authority.authorized) {
    return refuse(
      preflightNote(authority.reason) +
      ' The disposable development database does not define the operational channel.'
    );
  }
  const urlFailure = validateDatabaseUrl(authority.databaseUrl);
  if (urlFailure) {
    return refuse(preflightNote(urlFailure));
  }

  // 2. Canonical configuration validity (the same gate as server boot).
  const configuration = validateEnvironment(env, { context: 'boot' });
  facts.configuration = { ok: configuration.ok, failures: configuration.failures };
  if (!configuration.ok) {
    return refuse(preflightNote(
      `${configuration.failures.length} configuration failure(s): ` +
      configuration.failures.map(failure => failure.name ? failure.name : 'configuration').join(', ') +
      ' — resolve before deployment'
    ));
  }

  // 3. Credential-free exact operational identity BEFORE any contact.
  facts.identity = formatTargetIdentity(operationalIdentityFrom(authoritySnapshot(authority)));
  lines.push(preflightNote(`operational channel: ${authority.source}; ${facts.identity}`));

  // 4. Effect-root usability through the single canonical walk.
  const effectRoots = effectRootReadiness([
    { id: 'workspace', root: path.resolve(cwd, String(env.WORKSPACE_ROOT || OPERATOR_GUIDE_DEFAULT_WORKSPACE_ROOT)) },
    { id: 'artifacts', root: path.resolve(cwd, String(env.ARTIFACT_ROOT || CANONICAL_ARTIFACT_ROOT_DEFAULT)) }
  ]);
  facts.effectRoots = effectRoots;
  const unusable = effectRoots.filter(entry => !entry.usable);
  if (unusable.length > 0) {
    return refuse(preflightNote(
      'effect roots not usable: ' +
      unusable.map(entry => `${entry.id} (${entry.reason})`).join(', ')
    ));
  }

  // 5. Reachability + ledger/identity compatibility + the T10 integrity gate
  //    (single READ ONLY transaction per check, store closed immediately).
  const store = new PostgresRuntimeStore({
    connectionString: authority.databaseUrl,
    schema: authority.postgresSchema
  });
  let status = null;
  try {
    status = await store.getMigrationStatus();
  } catch (error) {
    await store.close().catch(() => {});
    return refuse(preflightNote(
      `the operational database is unreachable (reachability failure: connect refused by the configured target; ` +
      'readiness-class postgres_unreachable; no credentials or state reflected)'
    ));
  }
  facts.migrationStatus = status;
  try {
    const classification = classifyMigrationStatus(status);
    facts.migration = { code: classification.code, compatible: classification.compatible };
    if (!classification.compatible) {
      return refuse(prepareMigrationRefusalMessage(status, classification.code));
    }
    await store.prepareRuntimePersistence();

    // 6. Read-only account/provider readiness observation (informational only).
    let agents = null;
    try {
      agents = await observeConfiguredAgents(store);
      facts.configuredAgents = agents;
      if (agents.count < 1) {
        lines.push(preflightNote(
          'no configured agent found in the operational catalog (informational; production runs stay pending until one is configured)'
        ));
      } else {
        lines.push(preflightNote(`configured agents observed: ${agents.count}`));
      }
    } catch (_) {
      facts.configuredAgents = { observed: false };
      lines.push(preflightNote('configured-agent observation unavailable (left informational)'));
    }
  } finally {
    await store.close().catch(() => {});
  }

  lines.push(preflightNote('read-only preflight passed (no configuration, schema, or authorization mutation performed)'));
  return { ok: true, facts, lines };
}

function authoritySnapshot(authority) {
  return {
    databaseUrl: authority.databaseUrl,
    postgresSchema: authority.postgresSchema
  };
}

function prepareMigrationRefusalMessage(status, code) {
  const pending = Number(status.pendingMigrations) || 0;
  const unknown = Number(status.unknownMigrations) || 0;
  return preflightNote(
    `the operational ledger is not compatible with this source: classification ${code}; ` +
    `pending migrations: ${pending}; unknown migrations: ${unknown}; identity checksums valid: ` +
    `${Boolean(status.checksumsValid)}; the server refuses to start against it — resolve the ` +
    'T10-gated transition first (never from this preflight)'
  );
}

module.exports = { runOperationalPreflight, preflightNote };

if (require.main === module) {
  const selfTest = async () => {
    const assert = require('assert/strict');
    const os = require('os');
    const fs = require('fs');
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-preflight-selftest-'));
    try {
      const noFileConfig = path.join(fixtureDir, 'definitely-absent.env');
      const unconfigured = await runOperationalPreflight({
        env: {},
        noFileConfig: undefined,
        cwd: process.cwd(),
        localEnvFile: noFileConfig
      });
      assert.equal(unconfigured.ok, false, 'self-test: an unconfigured channel must refuse');
      assert.match(String(unconfigured.reason), /requires an explicit nonempty DATABASE_URL/);
      const blank = await runOperationalPreflight({ env: { DATABASE_URL: '   ' }, cwd: process.cwd(), localEnvFile: noFileConfig });
      assert.equal(blank.ok, false, 'self-test: a blank explicit DATABASE_URL must refuse');
      assert.match(String(blank.reason), /explicitly present but empty/);
      const badSecret = await runOperationalPreflight({
        env: { DATABASE_URL: 'postgresql://selftest:pw@127.0.0.1:1/never_reached', SESSION_SECRET: 'short' },
        cwd: process.cwd(),
        localEnvFile: noFileConfig
      });
      assert.equal(badSecret.ok, false, 'self-test: invalid configuration must refuse');
      assert.match(String(badSecret.reason), /configuration failure/);
      const unreachable = await runOperationalPreflight({
        env: { DATABASE_URL: 'postgresql://selftest:pw@127.0.0.1:1/never_reached',
          SESSION_SECRET: `selftest-session-secret-${'x'.repeat(64)}` },
        cwd: process.cwd(),
        localEnvFile: noFileConfig
      });
      assert.equal(unreachable.ok, false, 'self-test: a configured but unreachable database must refuse');
      assert.match(String(unreachable.reason), /unreachable/);
      assert.doesNotMatch(unreachable.lines.join('\n') + unreachable.reason, /selftest:pw/,
        'no credential material in any rendered fact');
      assert.doesNotMatch(String(unreachable.facts.identity || ''), /postgresql/,
        'the rendered operational identity stays credential-free');
      return 0;
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  };

  if (process.argv.includes('--self-test')) {
    selfTest().then(code => {
      process.stdout.write('PASS: operational preflight self-test (no database contact)\n');
      process.exitCode = code;
    }).catch(error => {
      process.stderr.write(`FAIL: operational preflight self-test: ${error && error.message ? error.message : error}\n`);
      process.exitCode = 1;
    });
  } else {
    runOperationalPreflight().then(result => {
      for (const line of result.lines) process.stdout.write(`${line}\n`);
      if (!result.ok) {
        process.stderr.write(`${result.reason}\n`);
        process.exitCode = 1;
      }
    }).catch(error => {
      process.stderr.write(`OPERATIONAL_PREFLIGHT failed: ${error && error.message ? error.message : error}\n`);
      process.exitCode = 1;
    });
  }
}
