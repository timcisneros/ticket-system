#!/usr/bin/env node
'use strict';

// Development doctor (read-only). P6-DEVEX-A semantics:
//
// The doctor diagnoses the FIXED repository-owned disposable development
// target (scripts/dev-environment.js: host 127.0.0.1, database
// ticket_system_dev, schema ticket_system; bounded bundled port). The
// configured DATABASE_URL remains the operational/persistent target: it is
// validated and rendered as ONE non-mutating informational identity row
// (never contacted), and it can never redirect the development target.
//
// Development migration-ledger guidance is honest under the disposable
// development authority (docs/DEPLOYMENT_CONTRACT.md §9 development category;
// docs/ARCHITECTURAL_DECISIONS_PENDING.md P6-DEVEX-A entry):
//
//   CURRENT   — canonical ledger current and identities valid.
//   BEHIND    — informational: `npm run dev` auto-migrates the disposable
//               development database to the canonical source head under the
//               code-declared disposable development authority (this row
//               makes NO authorization claim and never implies the
//               OPERATIONAL channel may migrate without authorization).
//   MISSING   — informational: `npm run dev` / `npm run dev:setup`
//               provisions it.
//   CORRUPT   — unknown future migrations, applied-identity drift, or a
//               partial ledger → FAIL, remediation is exactly
//               `npm run dev:reset` (destroy + recreate + migrate the fixed
//               disposable identity only).
//   COLLISION — the configured operational target identity equals the fixed
//               development identity → FAIL BEFORE ANY CONTACT.
//
// Operational migration-authority classification (behind+authorized /
// behind+unauthorized) is NOT attempted here: the operational channel is not
// the development diagnosis target, and the canonical authority inspection
// remains owned by the migration gate (persistence/postgres/migration-authority.js,
// pinned by scripts/migration-execution-authority-test.js).
//
// Every migration fact comes from the canonical persistence owner
// (`PostgresRuntimeStore.getMigrationStatus`, `migration-authority`
// helpers); no check writes anything. Configuration checks derive from the
// canonical environment registry (runtime/environment-config-registry.js).
// Secret values are never printed.

const argon2 = require('argon2');
const fs = require('fs');
const path = require('path');
const {
  PostgresRuntimeStore,
  migrationChecksum,
  migrationFiles,
  quoteIdentifier
} = require('../persistence/postgres/store');
const {
  assessBundledServiceTopologyGuard,
  assessDevelopmentTargetCollision,
  applyLocalEnv,
  createGuardedDevelopmentStore,
  developmentConfig,
  formatTargetIdentity,
  safeErrorMessage,
  targetIdentity,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writablePathStatus
} = require('./dev-environment');
const migrationAuthority = require('../persistence/postgres/migration-authority');
const {
  validateEnvironment
} = require('../runtime/environment-config-registry');
const { agentReadiness, firstConfiguredAgentPage } = require('./dev-agent-config');

function addCheck(checks, status, label, message) {
  checks.push({ status, label, message });
}

function postgresHelp() {
  return 'Start local PostgreSQL with `pnpm dev:db`, then run `pnpm dev:setup`.';
}

function packageManagerCheck(userAgent) {
  const text = String(userAgent || '');
  const pnpmMatch = text.match(/pnpm\/(\d+)(?:\.|\s|$)/);
  if (pnpmMatch) {
    return { status: Number(pnpmMatch[1]) >= 11 ? 'pass' : 'fail', label: 'pnpm', message: pnpmMatch[1] };
  }
  const npmMatch = text.match(/npm\/(\d+)(?:\.|\s|$)/);
  if (npmMatch) {
    return { status: 'pass', label: 'npm', message: `${npmMatch[1]}; supported script runner` };
  }
  return { status: 'warn', label: 'package manager', message: 'version could not be inferred' };
}

// ── Pure disposable-development migration-ledger state classification ──────
//
// Consumes CANONICAL facts only: the exact `getMigrationStatus()` shape, the
// read-only observation (`observeAppliedMigrationState`), the applied-identity
// evaluator (`evaluateAppliedMigrationIdentities` — evaluated over the applied
// subset so a ledger that is simply behind is not mis-classified as drifted),
// and the canonical pending-set helper. It never re-implements enumeration,
// checksum handling, or identity evaluation, and it makes NO migration
// authorization claim: the disposable development authority is a repository
// code declaration, and the operational migration-execution authority is not
// consulted for this target.
//
// States: current | behind_disposable | uninitialized | incompatible_unknown |
// drifted, plus an honest message.
function classifyDisposableDevelopmentLedgerState({
  schemaExists = false,
  ledgerExists = false,
  appliedVersions = [],
  status,
  migrations,
  migrationChecksum: checksum = migrationChecksum,
  identityRows = null,
  pendingMigrations = null
}) {
  const statusShape = status || {};
  if (!schemaExists || !ledgerExists) {
    return {
      state: 'uninitialized',
      message: 'the disposable development database has no migration ledger yet; `npm run dev` (or `npm run dev:setup`) provisions and auto-migrates it under the code-declared disposable development authority (the operational migration-execution authorization record is not involved)',
      remediation: null,
      pending: null
    };
  }
  const unknownMigrations = Number(statusShape.unknownMigrations) || 0;
  if (unknownMigrations > 0) {
    return {
      state: 'incompatible_unknown',
      message: `the development ledger contains ${unknownMigrations} migration(s) that are not part of this repository's canonical migration set (unknown future migrations); this is incompatible disposable state`,
      remediation: '`npm run dev:reset` (destroys and recreates ONLY the disposable development database)',
      pending: null
    };
  }
  if (identityRows) {
    const appliedSet = new Set(appliedVersions);
    const appliedIdentityEvaluation = migrationAuthority.evaluateAppliedMigrationIdentities(
      identityRows,
      migrations.filter(version => appliedSet.has(version)),
      checksum
    );
    if (!appliedIdentityEvaluation.ok) {
      return {
        state: 'drifted',
        message: `development applied migration identities are not valid (checksum/history drift): ${appliedIdentityEvaluation.reasons.slice(0, 5).join('; ')}`,
        remediation: '`npm run dev:reset` (destroys and recreates ONLY the disposable development database)',
        pending: null
      };
    }
  }
  if (statusShape.partial === true) {
    return {
      state: 'drifted',
      message: 'the canonical migration facts report a partial or inconsistent development ledger',
      remediation: '`npm run dev:reset` (destroys and recreates ONLY the disposable development database)',
      pending: null
    };
  }
  const pending = Array.isArray(pendingMigrations)
    ? pendingMigrations
    : migrationAuthority.computePendingMigrations(
        migrationAuthority.canonicalizeAppliedVersions(appliedVersions, migrations),
        migrations,
        checksum
      );
  if (statusShape.fullyApplied === true && pending.length === 0) {
    return {
      state: 'current',
      message: 'the disposable development schema is fully current and migration identities are valid',
      remediation: null,
      pending: []
    };
  }
  if (pending.length === 0) {
    return {
      state: 'drifted',
      message: 'the development ledger is in a partial or inconsistent state the canonical migration facts do not resolve',
      remediation: '`npm run dev:reset` (destroys and recreates ONLY the disposable development database)',
      pending: []
    };
  }
  return {
    state: 'behind_disposable',
    message: `the disposable development schema is behind the canonical migration source by ${pending.length} pending migration(s); \`npm run dev\` will auto-migrate this disposable development database to the source head (no migration-execution authorization is involved for this code-declared disposable target)`,
    remediation: null,
    pending: pending.map(entry => entry.version)
  };
}

function ledgerCheckRow(classification, schemaName) {
  switch (classification.state) {
    case 'current':
      return { status: 'pass', label: 'PostgreSQL migrations', message: `schema ${schemaName}: ${classification.message}` };
    case 'behind_disposable':
    case 'uninitialized':
      return {
        status: 'info',
        label: 'PostgreSQL migrations',
        message: `schema ${schemaName}: ${classification.message}` +
          (classification.remediation ? ` Remediation: ${classification.remediation}` : '')
      };
    default:
      return {
        status: 'fail',
        label: 'PostgreSQL migrations',
        message: `schema ${schemaName}: ${classification.message}. Remediation: ${classification.remediation || 'do not guess remediation; consult the migration authority doctrine'}`.trim()
      };
  }
}

// Missing-DATABASE failure shape (SQLSTATE 3D000). The disposable development
// database simply does not exist yet — information, not outage.
function isMissingDatabaseError(error) {
  return Boolean(error) && (
    error.code === '3D000' ||
    /database ".*" does not exist/.test(String(error && error.message))
  );
}

const REPO_ROOT = path.resolve(__dirname, '..');

async function inspectDevelopmentEnvironment({
  env = process.env,
  storeFactory = null,
  verifyPassword = argon2.verify
} = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  addCheck(checks, nodeMajor >= 24 ? 'pass' : 'fail', 'Node.js', nodeMajor >= 24 ? process.versions.node : `${process.versions.node}; version 24 or newer is required`);

  const packageManager = packageManagerCheck(env.npm_config_user_agent);
  addCheck(checks, packageManager.status, packageManager.label, packageManager.message);

  const config = developmentConfig(env);
  const databaseError = validateDatabaseUrl(config.databaseUrl);
  addCheck(checks, databaseError ? 'fail' : 'pass', 'DATABASE_URL', databaseError || 'configured PostgreSQL URL');

  const sessionError = validateSessionSecret(config.sessionSecret);
  addCheck(checks, sessionError ? 'fail' : 'pass', 'SESSION_SECRET', sessionError || 'configured with sufficient length');

  for (const [label, target] of [['workspace path', config.workspaceRoot], ['artifact path', config.artifactRoot]]) {
    const result = writablePathStatus(target);
    addCheck(checks, result.ok ? 'pass' : 'fail', label, result.message);
  }

  // Registry-derived configuration row(s): every remaining supported-setting
  // failure the canonical registry reports for this environment is surfaced
  // by NAME (never a value). A valid environment adds no rows.
  const registryValidation = validateEnvironment(env, { context: 'doctor' });
  const alreadyReported = new Set(['DATABASE_URL', 'SESSION_SECRET']);
  for (const failure of registryValidation.failures) {
    if (alreadyReported.has(failure.name)) continue;
    addCheck(checks, 'fail', failure.name, `${failure.message} (canonical registry: runtime/environment-config-registry.js)`);
  }

  if (databaseError) return { ok: false, checks, config };

  // Fixed development target identity + topology/collision guards (all
  // derivation is code/constants — NO database contact). On refusal the
  // doctor stops before any development or operational database interaction.
  let devAssessment = null;
  let topologyAssessment = null;
  try {
    devAssessment = assessDevelopmentTargetCollision(env);
  } catch (error) {
    addCheck(checks, 'fail', 'Disposable development target',
      `${safeErrorMessage(error)}; the fixed development identity cannot be constructed. Fix the setting (or remove it) and rerun.`);
  }
  if (devAssessment && devAssessment.ok) {
    try {
      topologyAssessment = assessBundledServiceTopologyGuard(env);
    } catch (error) {
      topologyAssessment = {
        ok: false,
        operational: devAssessment.operational,
        reason: safeErrorMessage(error)
      };
    }
  }
  const operationalInfoRow = identity =>
    addCheck(checks, 'info', 'Operational database (informational, never contacted)',
      `configured operational target: ${formatTargetIdentity(identity)} — operational/persistent state; the migration-execution authorization gate applies; dev commands do not migrate it`);

  if (devAssessment && devAssessment.ok && topologyAssessment && !topologyAssessment.ok) {
    addCheck(checks, 'fail', 'Bundled service port', `${topologyAssessment.reason}.`);
    if (devAssessment.operational) operationalInfoRow(devAssessment.operational);
    return { ok: false, checks, config };
  }
  if (devAssessment && devAssessment.ok) {
    addCheck(checks, 'pass', 'Disposable development target',
      `${formatTargetIdentity(targetIdentity(devAssessment.devTarget))} — code-owned; DATABASE_URL/POSTGRES_SCHEMA cannot redirect it; \`npm run dev\` ensures and auto-migrates it; \`npm run dev:reset\` destroys ONLY it`);
    if (devAssessment.operational) operationalInfoRow(devAssessment.operational);
  } else if (devAssessment) {
    addCheck(checks, 'fail', 'Development target collision', `${devAssessment.reason}.`);
    if (devAssessment.operational) operationalInfoRow(devAssessment.operational);
  }

  // DEV-COLLISION-A: on refusal the doctor proves NO database contact — the
  // store below is never constructed when the identity guard refuses.
  if (!devAssessment || !devAssessment.ok) {
    return { ok: false, checks, config };
  }

  let store;
  try {
    // The default diagnosis store is the ordinary GUARDED development seam
    // (scripts/dev-environment.js createGuardedDevelopmentStore): it carries
    // NO disposable migration authority and cannot migrate anything — the
    // doctor is read-only. Overrides (tests) may supply the store whose facts
    // are inspected; no identity is accepted from callers.
    store = storeFactory ? storeFactory() : createGuardedDevelopmentStore(env);
    const storeSchema = store.schema;

    let probeStatus = null;
    let probeError = null;
    try {
      probeStatus = await store.getMigrationStatus();
    } catch (error) {
      probeError = error;
    }

    if (probeError && isMissingDatabaseError(probeError)) {
      addCheck(checks, 'info', 'Disposable development database',
        'the disposable development database does not exist yet; `npm run dev` (or `npm run dev:setup`) provisions it and auto-migrates it to the canonical source head under the code-declared disposable development authority');
      addCheck(checks, 'info', 'admin account', 'cannot be inspected before the disposable development database exists; `npm run dev` / `npm run dev:setup` provisions it');
      addCheck(checks, 'info', 'configured agents', 'cannot be inspected before the disposable development database exists; `npm run dev` / `npm run dev:setup` provisions it');
      return { ok: !checks.some(check => check.status === 'fail'), checks, config };
    }
    if (probeError) {
      addCheck(checks, 'fail', 'PostgreSQL', `${safeErrorMessage(probeError)}. ${postgresHelp()}`);
      return { ok: false, checks, config };
    }

    let classification = null;
    try {
      const migrations = migrationFiles();
      const schemaSql = quoteIdentifier(storeSchema);
      const observed = await store.withTransaction(async client =>
        migrationAuthority.observeAppliedMigrationState(client, { schema: storeSchema, schemaSql }));
      let identityRows = null;
      if (observed.ledgerExists) {
        try {
          const result = await store.withTransaction(async client => client.query(
            `SELECT version, sha256 FROM ${schemaSql}."schema_migration_identities"`
          ));
          identityRows = result.rows;
        } catch (_) {
          identityRows = null;
        }
      }
      classification = classifyDisposableDevelopmentLedgerState({
        schemaExists: observed.schemaExists,
        ledgerExists: observed.ledgerExists,
        appliedVersions: observed.appliedVersions,
        status: probeStatus,
        migrations,
        migrationChecksum,
        identityRows
      });
      const row = ledgerCheckRow(classification, storeSchema);
      addCheck(checks, row.status, row.label, row.message);
    } catch (error) {
      addCheck(checks, 'fail', 'PostgreSQL migrations', `${safeErrorMessage(error)}; migration ledger state could not be established fail-closed`);
      classification = null;
    }

    if (classification) {
      const admin = await store.getUserByUsername('admin');
      if (!admin) {
        const passwordError = validateAdminPassword(config.adminBootstrapPassword, { required: true });
        const detail = passwordError ? `${passwordError}; run pnpm dev:setup` : 'account is missing; run pnpm dev:setup';
        addCheck(checks, 'fail', 'admin account', detail);
      } else {
        addCheck(checks, 'pass', 'admin account', 'configured');
        try {
          if (await verifyPassword(admin.passwordHash, 'admin123')) {
            addCheck(checks, 'warn', 'admin password', 'current password is a predictable default; change it with pnpm admin:password');
          }
        } catch (_) {
          // A malformed stored hash is reported by runtime integrity checks.
        }
      }

      const agentPage = await firstConfiguredAgentPage(store);
      const readiness = agentPage.agents.map(agent => ({
        agent,
        status: agentReadiness(agent, env)
      }));
      const readyAgents = readiness.filter(item => item.status.ready);
      if (agentPage.agents.length === 0) {
        addCheck(checks, 'fail', 'configured agents', 'none exist; run pnpm dev:setup');
      } else if (readyAgents.length === 0) {
        const reasons = [...new Set(readiness.flatMap(item => item.status.reasons))].join(', ');
        addCheck(checks, agentPage.truncated ? 'warn' : 'fail', 'runnable agent configuration',
          agentPage.truncated
            ? `none of the first 100 agents is runnable (${reasons}); inspect the remaining catalog in Admin`
            : `no agent has complete provider configuration (${reasons}); update Admin or rerun pnpm dev:setup`);
      } else {
        addCheck(checks, 'pass', 'runnable agent configuration',
          `${readyAgents.length} of ${agentPage.agents.length} inspected agent(s) have a provider, model, and required credential`);
      }
      if (agentPage.truncated) {
        addCheck(checks, 'warn', 'configured agents', 'doctor inspection is intentionally bounded to the first 100 agents');
      }
    }
  } catch (error) {
    addCheck(checks, 'fail', 'PostgreSQL', `${safeErrorMessage(error)}. ${postgresHelp()}`);
  } finally {
    if (store) await store.close();
  }

  return { ok: !checks.some(check => check.status === 'fail'), checks, config };
}

function printChecks(result, output = process.stdout) {
  for (const check of result.checks) {
    const prefix = check.status === 'info' ? 'INFO' : check.status.toUpperCase();
    output.write(`[${prefix}] ${check.label}: ${check.message}\n`);
  }
  output.write(result.ok ? 'Development environment is ready.\n' : 'Development environment needs attention.\n');
}

async function runDoctor(options = {}) {
  applyLocalEnv(options.env || process.env);
  const result = await inspectDevelopmentEnvironment({
    ...options,
    env: options.env || process.env
  });
  printChecks(result, options.output || process.stdout);
  return result.ok;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm dev:doctor\n\nRuns read-only development environment checks against the fixed disposable development database. The configured operational DATABASE_URL is shown as one informational row and never contacted. Secret values are never printed.');
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:doctor does not accept arguments');
  if (!await runDoctor()) process.exitCode = 1;
}

module.exports = {
  classifyDisposableDevelopmentLedgerState,
  inspectDevelopmentEnvironment,
  isMissingDatabaseError,
  ledgerCheckRow,
  packageManagerCheck,
  postgresHelp,
  printChecks,
  runDoctor
};

if (require.main === module) {
  main().catch(error => {
    console.error(`Development doctor failed: ${safeErrorMessage(error)}`);
    process.exit(1);
  });
}
