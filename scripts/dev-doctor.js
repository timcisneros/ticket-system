#!/usr/bin/env node
'use strict';

// Development doctor (read-only). P6-S2 semantics:
//
// Migration-ledger guidance is honest under the migration-execution authority
// gate (docs/DEPLOYMENT_CONTRACT.md §9). Operators are told which state the
// schema is actually in instead of being told to run `pnpm dev:setup` as if
// that command could bypass the gate:
//
//   CURRENT             — canonical ledger current and identity valid.
//   BEHIND + AUTHORIZED — a governed exact pending transition is currently
//                         authorized; apply it through the canonical migration
//                         command (setup routes through the same gate).
//   BEHIND + NOT AUTHORIZED — pending migrations exist and the canonical
//                         migration-execution authority inspection refuses
//                         that exact transition; `pnpm dev:setup` cannot and
//                         will not bypass T10 — the governed migration/bootstrap
//                         procedure owns authorization.
//   BEHIND + NOT VERIFIED — the canonical authority facts could not be
//                         established read-only (for example git/publication
//                         transport failure); the transition is NOT claimable
//                         as authorized. The migration command remains the
//                         final authority.
//   INCOMPATIBLE / DRIFTED — unknown future migrations, applied-identity
//                         checksum drift, uninitialized/no ledger, or a
//                         partial ledger; fail-closed with no guessed
//                         remediation.
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
const migrationAuthority = require('../persistence/postgres/migration-authority');
const {
  applyLocalEnv,
  developmentConfig,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writablePathStatus
} = require('./dev-environment');
const {
  validateEnvironment
} = require('../runtime/environment-config-registry');
const { agentReadiness, firstConfiguredAgentPage } = require('./dev-agent-config');

// The canonical machinery that can apply an authorized transition —
// referenced rather than re-derived (docs/DEPLOYMENT_CONTRACT.md §9). The
// authorization record has a canonical tracked home and is never written by
// the doctor or setup. Doctor authorization diagnostics reuse the CANONICAL
// read-only authority inspection (`migrationAuthority.inspectTransitionAuthority`)
// — the exact shared implementation the enforcing migration gate performs —
// so the doctor can never classify an exact transition as authorized when the
// canonical migration-execution authority does not.
const GOVERNED_MIGRATION_PROCEDURE =
  'apply it with the canonical migration command (`npm run db:migrate`, which runs the governed authority gate; `pnpm dev:setup` routes through the same gate)';
const BOOTSTRAP_AUTHORITY_PROCEDURE =
  'authorize a transition only through the governed migration/bootstrap authority (config/migration-execution-authorization.json and the migration/bootstrap doctrine in docs/DEPLOYMENT_CONTRACT.md)';

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

// ── Pure migration-ledger state classification ─────────────────────────────
//
// Consumes CANONICAL facts only: the exact `getMigrationStatus()` shape, the
// read-only observation (`observeAppliedMigrationState`), the applied-identity
// evaluator (`evaluateAppliedMigrationIdentities` — evaluated over the applied
// subset so a ledger that is simply behind is not mis-classified as drifted),
// the canonical pending-set helper, and the CANONICAL migration-execution
// authority inspection (`migrationAuthority.inspectTransitionAuthority` — the
// exact shared read-only authority path the enforcing gate performs). It never
// re-implements enumeration, checksum handling, target binding, publication
// authority, or authorization evaluation: the classifier consumes the
// canonical inspection OUTCOME verbatim.
//
// Returns one of: current | behind_authorized | behind_unauthorized |
// behind_authorization_record_present_but_not_verified | uninitialized |
// incompatible_unknown | drifted, plus an honest message and (for behind
// states) the exact pending-transition facts.
//
// The positive `behind_authorized` classification is reachable ONLY when the
// canonical authority inspection itself returns ok — i.e. the exact transition
// being diagnosed (target identity, required applied pre-state, ordered pending
// set with source sha256, authorized baseline, and repository/publication
// authority) is genuinely authorized at inspection time. Every conservative
// outcome name must never read as "execution is authorized": when the full
// authority facts cannot be established read-only (e.g. git/publication
// transport failure), the state is
// `behind_authorization_record_present_but_not_verified` — the migration
// command remains the final authority.
function classifyMigrationLedgerState({
  schemaExists = false,
  ledgerExists = false,
  appliedVersions = [],
  status,
  migrations,
  migrationChecksum: checksum = migrationChecksum,
  identityRows = null,
  pendingMigrations = null,
  authorizationInspection = null
}) {
  const statusShape = status || {};
  if (!schemaExists || !ledgerExists) {
    return {
      state: 'uninitialized',
      message: 'schema is not initialized (no migration ledger); a fresh bootstrap requires an authorized bootstrap transition',
      guidance: `initialization cannot start without an authorized transition — ${BOOTSTRAP_AUTHORITY_PROCEDURE}; pnpm dev:setup cannot bypass that gate`,
      pending: null
    };
  }
  const unknownMigrations = Number(statusShape.unknownMigrations) || 0;
  if (unknownMigrations > 0) {
    return {
      state: 'incompatible_unknown',
      message: `the ledger contains ${unknownMigrations} migration(s) that are not part of this repository's canonical migration set (unknown future migrations)`,
      guidance: 'this is incompatible state; the runtime fails closed. Do not guess remediation. Consult docs/DEPLOYMENT_CONTRACT.md (migration/bootstrap/rollback doctrine) and the migration authority records',
      pending: null
    };
  }
  let appliedIdentityEvaluation = null;
  if (identityRows) {
    const appliedSet = new Set(appliedVersions);
    appliedIdentityEvaluation = migrationAuthority.evaluateAppliedMigrationIdentities(
      identityRows,
      migrations.filter(version => appliedSet.has(version)),
      checksum
    );
    if (!appliedIdentityEvaluation.ok) {
      return {
        state: 'drifted',
        message: `applied migration identities are not valid (checksum/history drift): ${appliedIdentityEvaluation.reasons.slice(0, 5).join('; ')}`,
        guidance: 'this is incompatible state; the runtime fails closed. Applied migration bytes changed, an applied identity is missing, or an unknown identity row exists. Consult docs/DEPLOYMENT_CONTRACT.md and the migration authority records; do not guess remediation',
        pending: null
      };
    }
  }
  if (statusShape.partial === true) {
    return {
      state: 'drifted',
      message: 'the canonical migration facts report a partial ledger or invalid migration identities',
      guidance: 'this is incompatible state; the runtime fails closed. Consult docs/DEPLOYMENT_CONTRACT.md and the migration authority records; do not guess remediation',
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
      message: 'schema is fully current and migration identities are valid',
      guidance: null,
      pending: []
    };
  }
  if (pending.length === 0) {
    // No pending set yet the ledger is not fully applied and no canonical
    // fact names the inconsistency.
    return {
      state: 'drifted',
      message: 'the ledger is in a partial or inconsistent state the canonical migration facts do not resolve',
      guidance: 'this is incompatible state; the runtime fails closed. Consult docs/DEPLOYMENT_CONTRACT.md and the migration authority records; do not guess remediation',
      pending: []
    };
  }
  const behindCount = pending.length;
  if (authorizationInspection && authorizationInspection.ok === true) {
    return {
      state: 'behind_authorized',
      message: `schema is behind by ${behindCount} pending migration(s) and the pending transition IS authorized for this exact target, pre-state, and migration set (record ${authorizationInspection.migrationTransitionId}, as may be applied by the canonical migration command ONLY)`,
      guidance: GOVERNED_MIGRATION_PROCEDURE,
      pending: pending.map(entry => entry.version)
    };
  }
  if (!authorizationInspection ||
      (authorizationInspection.unverifiable === true)) {
    const reasons = authorizationInspection ? authorizationInspection.reasons : ['the canonical authorization inspection was not performed'];
    return {
      state: 'behind_authorization_record_present_but_not_verified',
      message: `schema is behind by ${behindCount} pending migration(s) and the pending transition could NOT be verified as authorized through read-only canonical inspection (the repository/publication authority or the authorization record could not be established: ${reasons.slice(0, 5).join('; ')}) — it must be treated as NOT authorized until verified`,
      guidance: `the canonical migration command re-establishes the full authority at execution time and remains the final authority; pnpm dev:setup cannot bypass the migration execution authority. ${BOOTSTRAP_AUTHORITY_PROCEDURE}, then run the canonical migration command`,
      pending: pending.map(entry => entry.version)
    };
  }
  const canonicalReasons = authorizationInspection.reasons || [];
  const recordNotAuthorized = canonicalReasons.some(reason =>
    /authorizationState .* is not "AUTHORIZED"/.test(reason));
  return {
    state: 'behind_unauthorized',
    message: `schema is behind by ${behindCount} pending migration(s) and the pending transition is NOT authorized by the canonical migration-execution authority` +
      (recordNotAuthorized
        ? ' (the canonical authorization record is NOT_AUTHORIZED)'
        : ' (the canonical authorization record does not authorize this exact pending transition)') +
      `: ${canonicalReasons.slice(0, 5).join('; ')}`,
    guidance: `pnpm dev:setup cannot bypass the migration execution authority. ${BOOTSTRAP_AUTHORITY_PROCEDURE}, then run the canonical migration command`,
    pending: pending.map(entry => entry.version)
  };
}

function ledgerCheckRow(classification, schemaName) {
  switch (classification.state) {
    case 'current':
      return { status: 'pass', label: 'PostgreSQL migrations', message: `schema ${schemaName}: ${classification.message}` };
    case 'behind_authorized':
      return { status: 'warn', label: 'PostgreSQL migrations', message: `${classification.message}; ${classification.guidance}` };
    default:
      return {
        status: 'fail',
        label: 'PostgreSQL migrations',
        message: `${classification.message}. ${classification.guidance || ''}`.replace(/\s+\.$/, '.').trim()
      };
  }
}

const AUTHORIZATION_RECORD_RELATIVE_PATH = path.join('config', 'migration-execution-authorization.json');
const REPO_ROOT = path.resolve(__dirname, '..');

function readAuthorizationRecordRaw(navRoot = REPO_ROOT) {
  try {
    return fs.readFileSync(path.join(navRoot, AUTHORIZATION_RECORD_RELATIVE_PATH), 'utf8');
  } catch (_) {
    return null;
  }
}

async function inspectDevelopmentEnvironment({
  env = process.env,
  storeFactory = config => new PostgresRuntimeStore(config),
  verifyPassword = argon2.verify,
  authorizationRecordRaw = undefined
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

  let store;
  try {
    store = storeFactory({ connectionString: config.databaseUrl, schema: config.postgresSchema });

    let probeStatus = null;
    let probeFailed = false;
    try {
      probeStatus = await store.getMigrationStatus();
    } catch (error) {
      probeFailed = true;
      addCheck(checks, 'fail', 'PostgreSQL', `${safeErrorMessage(error)}. ${postgresHelp()}`);
    }

    let classification = null;
    if (!probeFailed) {
      try {
        const migrations = migrationFiles();
        const schemaSql = quoteIdentifier(config.postgresSchema);
        const observed = await store.withTransaction(async client =>
          migrationAuthority.observeAppliedMigrationState(client, { schema: config.postgresSchema, schemaSql }));
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
        // Canonical authorization diagnosis (read-only). The doctor NEVER
        // decides T10 authority itself: when the observed ledger is behind, the
        // exact transition is inspected through the canonical shared
        // implementation the enforcing migration gate performs — target
        // identity, required applied pre-state, ordered pending set with
        // source sha256, authorized baseline, and repository/publication
        // authority. Transport-level refusals produce the conservative
        // `behind_authorization_record_present_but_not_verified` state; a
        // decision refusal produces `behind_unauthorized`. Only `ok === true`
        // from that canonical inspection can classify `behind_authorized`.
        let pendingMigrations = null;
        let authorizationInspection = null;
        if (observed.ledgerExists) {
          pendingMigrations = migrationAuthority.computePendingMigrations(
            migrationAuthority.canonicalizeAppliedVersions(observed.appliedVersions, migrations),
            migrations,
            migrationChecksum
          );
          if (pendingMigrations.length > 0) {
            authorizationInspection = migrationAuthority.inspectTransitionAuthority({
              repoRoot: REPO_ROOT,
              connectionString: config.databaseUrl,
              schema: config.postgresSchema,
              currentDatabaseName: observed.databaseName,
              migrations,
              migrationChecksum,
              appliedVersions: observed.appliedVersions,
              pendingMigrations,
              loadRecordRaw: () => authorizationRecordRaw === undefined
                ? readAuthorizationRecordRaw()
                : authorizationRecordRaw
            });
          }
        }
        classification = classifyMigrationLedgerState({
          schemaExists: observed.schemaExists,
          ledgerExists: observed.ledgerExists,
          appliedVersions: observed.appliedVersions,
          status: probeStatus,
          migrations,
          migrationChecksum,
          identityRows,
          pendingMigrations,
          authorizationInspection
        });
        const row = ledgerCheckRow(classification, config.postgresSchema);
        addCheck(checks, row.status, row.label, row.message);
      } catch (error) {
        addCheck(checks, 'fail', 'PostgreSQL migrations', `${safeErrorMessage(error)}; migration ledger state could not be established fail-closed`);
      }
    }

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
  } catch (error) {
    addCheck(checks, 'fail', 'PostgreSQL', `${safeErrorMessage(error)}. ${postgresHelp()}`);
  } finally {
    if (store) await store.close();
  }

  return { ok: !checks.some(check => check.status === 'fail'), checks, config };
}

function printChecks(result, output = process.stdout) {
  for (const check of result.checks) {
    output.write(`[${check.status.toUpperCase()}] ${check.label}: ${check.message}\n`);
  }
  output.write(result.ok ? 'Development environment is ready.\n' : 'Development environment needs attention.\n');
}

async function runDoctor(options = {}) {
  applyLocalEnv(options.env || process.env);
  const result = await inspectDevelopmentEnvironment(options);
  printChecks(result, options.output || process.stdout);
  return result.ok;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm dev:doctor\n\nRuns read-only development environment checks. Secret values are never printed.');
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:doctor does not accept arguments');
  if (!await runDoctor()) process.exitCode = 1;
}

module.exports = {
  classifyMigrationLedgerState,
  inspectDevelopmentEnvironment,
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
