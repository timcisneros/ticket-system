'use strict';

// Migration execution authority — T10 prevention infrastructure.
//
// One narrow contract: PostgresRuntimeStore.migrate() refuses unauthorized
// NON-disposable migration execution before any mutation (advisory lock,
// CREATE SCHEMA, CREATE TABLE, migration SQL, mutating migration hooks,
// schema_migrations writes, schema_migration_identities writes).
//
// Frozen semantics (independent review):
//   - exact target binding {host, port, database, schema}; no cross-target
//     replay;
//   - exact applied pre-state: requiredAppliedVersions is the exact ordered
//     applied migration-version list required before execution;
//   - exact pending-set binding: authorizedPendingMigrations is the exact
//     ordered pending set with source sha256 — membership, order, count and
//     source bytes must all match; no subset/superset admission;
//   - publication authority: tracked canonical record; clean repository;
//     HEAD == freshly queried origin refs/heads/master; authorizedBaselineHead
//     an ancestor of HEAD; no self-referential commit hash; the cached
//     origin/master tracking ref is diagnostic only;
//   - an empty pending set on a fully current, stray-free ledger (proven by
//     read-only observation) is a mutation-free no-op and requires no
//     transition authorization — and must not create schema/ledger state;
//   - disposable/test stores are exempt only by explicit repository-code
//     declaration (constructor flag); no env-var skip, no target-derived skip,
//     no "bundled == disposable" inference, no missing-schema inference.
//
// Order note: the pending set is only knowable from read-only database
// observation, so read-only observation precedes the repository Phase-A gate;
// Phase-A gates non-empty pending transitions only. Already-applied migration
// bytes remain under the existing schema_migration_identities custody and the
// existing unknown-future/history integrity checks are retained unchanged as
// defense in depth.

const { execFileSync } = require('child_process');

const RECORD_KIND = 'migration-execution-authorization';
const RECORD_VERSION = 1;
const AUTHORIZED = 'AUTHORIZED';
const NOT_AUTHORIZED = 'NOT_AUTHORIZED';
const AUTHORIZATION_STATES = Object.freeze([AUTHORIZED, NOT_AUTHORIZED]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;
const MIGRATION_VERSION = /^\d{3}_[a-z0-9_]+\.sql$/;
const RECORD_RELATIVE_PATH = 'config/migration-execution-authorization.json';
const RECORD_KEYS = Object.freeze([
  'recordKind',
  'recordVersion',
  'migrationTransitionId',
  'authorizationState',
  'expectedTarget',
  'requiredAppliedVersions',
  'authorizedPendingMigrations',
  'authorizedBaselineHead',
  'authorizedBy',
  'authorizedAtUtc'
]);
const EXPECTED_TARGET_KEYS = Object.freeze(['host', 'port', 'database', 'schema']);
const PENDING_ENTRY_KEYS = Object.freeze(['version', 'sha256']);
const FRESH_REMOTE_ARGS = Object.freeze(['ls-remote', '--exit-code', 'origin', 'refs/heads/master']);
const FRESH_REMOTE_COMMAND = `git ${FRESH_REMOTE_ARGS.join(' ')}`;
const FRESH_REMOTE_LINE = /^([0-9a-f]{40})\trefs\/heads\/master$/;
// RFC3339 date-time (frozen authorizedAtUtc contract). Validated by explicit
// Gregorian component rules — NOT by Date.parse, which normalizes some
// impossible day-of-month values (e.g. 2026-02-30) into finite timestamps.
// Repository convention for second: conventional clock sources only — second
// 60 (leap second) is NOT accepted; this is the documented policy rather than
// pretended leap-second validation. The explicit timezone designator is
// required (UTC designator or numeric offset); offsets are validated as
// hours 00-23, minutes 00-59.
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

function gregorianDaysInMonth(year, month) {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    default:
      return 0;
  }
}

function isRfc3339Timestamp(value) {
  if (typeof value !== 'string') return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > gregorianDaysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  return true;
}

class MigrationExecutionAuthorityError extends Error {
  constructor(reasons) {
    super(`Migration execution refused by repository authority: ${reasons.join('; ')}`);
    this.name = 'MigrationExecutionAuthorityError';
    this.code = 'MIGRATION_EXECUTION_AUTHORITY_REFUSED';
    this.reasons = Object.freeze([...reasons]);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Non-secret connection-target identity. Credentials are dropped here and are
// never surfaced in errors, refusals or evidence.
function parseTargetIdentity(connectionString) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new TypeError('connection target identity is unavailable for authorization binding');
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch (_) {
    throw new TypeError('connection target is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new TypeError('connection target must use postgres:// or postgresql://');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new TypeError('connection target must name a host and database');
  }
  return Object.freeze({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.slice(1))
  });
}

function targetMismatchReasons(observed, expected) {
  const reasons = [];
  if (!isPlainObject(expected)) {
    reasons.push('authorized expectedTarget is missing or malformed');
    return reasons;
  }
  if (observed.host !== expected.host) reasons.push(`target host ${observed.host} != authorized ${expected.host}`);
  if (observed.port !== expected.port) reasons.push(`target port ${observed.port} != authorized ${expected.port}`);
  if (observed.database !== expected.database) reasons.push(`target database ${observed.database} != authorized ${expected.database}`);
  if (observed.schema !== expected.schema) reasons.push(`target schema ${observed.schema} != authorized ${expected.schema}`);
  return reasons;
}

// Strict shape validation. A NOT_AUTHORIZED record must carry the exact
// deterministic null/empty authority fields; an AUTHORIZED record must carry
// fully shaped authority fields. Unknown or missing fields refuse.
function validateRecordShape(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MigrationExecutionAuthorityError([
      `canonical migration-execution authorization record missing at ${RECORD_RELATIVE_PATH}`
    ]);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new MigrationExecutionAuthorityError([`authorization record is not valid JSON: ${error.message}`]);
  }
  if (!isPlainObject(record)) {
    throw new MigrationExecutionAuthorityError(['authorization record is not a JSON object']);
  }
  const keys = Object.keys(record);
  const missing = RECORD_KEYS.filter(key => !keys.includes(key));
  const extra = keys.filter(key => !RECORD_KEYS.includes(key));
  const shapeReasons = [];
  if (missing.length > 0) shapeReasons.push(...missing.map(key => `missing field "${key}"`));
  if (extra.length > 0) shapeReasons.push(...extra.map(key => `unknown field "${key}"`));
  if (missing.length > 0 || extra.length > 0) {
    throw new MigrationExecutionAuthorityError(shapeReasons);
  }

  if (record.recordKind !== RECORD_KIND) {
    shapeReasons.push(`recordKind ${JSON.stringify(record.recordKind)} != expected "${RECORD_KIND}"`);
  }
  if (record.recordVersion !== RECORD_VERSION) {
    shapeReasons.push(`recordVersion ${JSON.stringify(record.recordVersion)} != expected ${RECORD_VERSION}`);
  }
  if (!AUTHORIZATION_STATES.includes(record.authorizationState)) {
    shapeReasons.push(`authorizationState ${JSON.stringify(record.authorizationState)} is not one of ${AUTHORIZATION_STATES.join('/')}`);
  }

  const target = record.expectedTarget;
  if (!isPlainObject(target)) {
    shapeReasons.push('expectedTarget is missing or is not a JSON object');
  } else {
    const targetKeys = Object.keys(target);
    if (targetKeys.length !== EXPECTED_TARGET_KEYS.length ||
        !EXPECTED_TARGET_KEYS.every(key => targetKeys.includes(key))) {
      shapeReasons.push(`expectedTarget fields must be exactly ${EXPECTED_TARGET_KEYS.join('/')}`);
    }
  }

  if (!Array.isArray(record.requiredAppliedVersions)) {
    shapeReasons.push('requiredAppliedVersions must be an array');
  } else {
    for (const version of record.requiredAppliedVersions) {
      if (typeof version !== 'string' || !MIGRATION_VERSION.test(version)) {
        shapeReasons.push(`requiredAppliedVersions entry ${JSON.stringify(version)} is not a canonical migration version`);
      }
    }
    const distinct = new Set(record.requiredAppliedVersions);
    if (distinct.size !== record.requiredAppliedVersions.length) {
      shapeReasons.push('requiredAppliedVersions contains duplicate versions');
    }
  }

  if (!Array.isArray(record.authorizedPendingMigrations)) {
    shapeReasons.push('authorizedPendingMigrations must be an array');
  } else {
    for (const entry of record.authorizedPendingMigrations) {
      if (!isPlainObject(entry)) {
        shapeReasons.push('authorizedPendingMigrations entries must be JSON objects');
        break;
      }
      const entryKeys = Object.keys(entry);
      if (entryKeys.length !== PENDING_ENTRY_KEYS.length ||
          !PENDING_ENTRY_KEYS.every(key => entryKeys.includes(key))) {
        shapeReasons.push(`authorizedPendingMigrations entries must have exactly ${PENDING_ENTRY_KEYS.join('/')}`);
        break;
      }
      if (typeof entry.version !== 'string' || !MIGRATION_VERSION.test(entry.version)) {
        shapeReasons.push(`authorizedPendingMigrations version ${JSON.stringify(entry.version)} is not a canonical migration version`);
      }
      if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
        shapeReasons.push(`authorizedPendingMigrations sha256 for ${entry.version} is not a sha256 hex digest`);
      }
    }
    const versions = Array.isArray(record.authorizedPendingMigrations)
      ? record.authorizedPendingMigrations.map(entry => (isPlainObject(entry) ? entry.version : null))
      : [];
    const distinct = new Set(versions);
    if (distinct.size !== versions.length) {
      shapeReasons.push('authorizedPendingMigrations contains duplicate versions');
    }
  }

  if (record.authorizationState === NOT_AUTHORIZED) {
    // Deterministic non-authorizing shape: every authority field is the exact
    // null/empty value, so a NOT_AUTHORIZED record cannot partially grant.
    if (record.migrationTransitionId !== null) shapeReasons.push('NOT_AUTHORIZED record must have migrationTransitionId null');
    if (JSON.stringify(record.expectedTarget) !== JSON.stringify({ host: null, port: null, database: null, schema: null })) {
      shapeReasons.push('NOT_AUTHORIZED record must have expectedTarget {host:null, port:null, database:null, schema:null}');
    }
    if (JSON.stringify(record.requiredAppliedVersions) !== '[]') shapeReasons.push('NOT_AUTHORIZED record must have requiredAppliedVersions []');
    if (JSON.stringify(record.authorizedPendingMigrations) !== '[]') shapeReasons.push('NOT_AUTHORIZED record must have authorizedPendingMigrations []');
    if (record.authorizedBaselineHead !== null) shapeReasons.push('NOT_AUTHORIZED record must have authorizedBaselineHead null');
    if (record.authorizedBy !== null) shapeReasons.push('NOT_AUTHORIZED record must have authorizedBy null');
    if (record.authorizedAtUtc !== null) shapeReasons.push('NOT_AUTHORIZED record must have authorizedAtUtc null');
  } else if (record.authorizationState === AUTHORIZED) {
    if (typeof record.migrationTransitionId !== 'string' || !record.migrationTransitionId.trim()) {
      shapeReasons.push('AUTHORIZED record must name a non-empty migrationTransitionId');
    }
    if (isPlainObject(record.expectedTarget)) {
      const { host, port, database, schema } = record.expectedTarget;
      if (typeof host !== 'string' || !host.trim()) shapeReasons.push('AUTHORIZED expectedTarget.host must be a non-empty string');
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) shapeReasons.push('AUTHORIZED expectedTarget.port must be a safe port integer');
      if (typeof database !== 'string' || !database.trim()) shapeReasons.push('AUTHORIZED expectedTarget.database must be a non-empty string');
      if (typeof schema !== 'string' || !schema.trim()) shapeReasons.push('AUTHORIZED expectedTarget.schema must be a non-empty string');
    }
    if (!Array.isArray(record.authorizedPendingMigrations) || record.authorizedPendingMigrations.length === 0) {
      shapeReasons.push('AUTHORIZED record must authorize a non-empty pending migration set');
    }
    if (typeof record.authorizedBaselineHead !== 'string' || !COMMIT_HEX.test(record.authorizedBaselineHead)) {
      shapeReasons.push('AUTHORIZED authorizedBaselineHead must be a 40-hex commit id');
    }
    if (typeof record.authorizedBy !== 'string' || !record.authorizedBy.trim()) {
      shapeReasons.push('AUTHORIZED record must name a non-empty authorizedBy');
    }
    if (typeof record.authorizedAtUtc !== 'string' || !isRfc3339Timestamp(record.authorizedAtUtc)) {
      shapeReasons.push('AUTHORIZED record must record authorizedAtUtc as an RFC3339 timestamp');
    }
  }

  if (shapeReasons.length > 0) throw new MigrationExecutionAuthorityError(shapeReasons);
  return record;
}

function canonicalizeAppliedVersions(appliedVersions, migrations) {
  const indexOf = new Map(migrations.map((version, index) => [version, index]));
  return [...appliedVersions].sort((a, b) => {
    const aKnown = indexOf.has(a);
    const bKnown = indexOf.has(b);
    if (aKnown && bKnown) return indexOf.get(a) - indexOf.get(b);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function computePendingMigrations(appliedVersions, migrations, migrationChecksum) {
  const applied = new Set(appliedVersions);
  return migrations
    .filter(version => !applied.has(version))
    .map(version => ({ version, sha256: migrationChecksum(version) }));
}

// Fully current means: every canonical migration is applied in canonical order
// and nothing stray is present. Only this state permits the mutation-free
// empty-pending no-op; a ledger with strays is not "already current".
function isFullyCurrentCanonicalLedger(appliedVersions, migrations) {
  if (appliedVersions.length !== migrations.length) return false;
  return migrations.every((version, index) => appliedVersions[index] === version);
}

// Pure transition evaluation. Every predicate failure becomes one refusal
// reason; the caller refuses before any migration mutation.
function evaluateTransition({
  record,
  observedTarget,
  appliedVersions,
  pendingMigrations,
  repositoryAuthority
}) {
  const reasons = [];
  if (record.authorizationState !== AUTHORIZED) {
    reasons.push(`authorizationState ${JSON.stringify(record.authorizationState)} is not "${AUTHORIZED}"`);
  } else {
    reasons.push(...targetMismatchReasons(observedTarget, record.expectedTarget));
    if (JSON.stringify(appliedVersions) !== JSON.stringify(record.requiredAppliedVersions)) {
      reasons.push(`applied migration pre-state ${JSON.stringify(appliedVersions)} != authorized requiredAppliedVersions ${JSON.stringify(record.requiredAppliedVersions)}`);
    }
    if (JSON.stringify(pendingMigrations) !== JSON.stringify(record.authorizedPendingMigrations)) {
      reasons.push(`actual pending migration set (membership/order/count/source sha256) ${JSON.stringify(pendingMigrations)} != authorized ${JSON.stringify(record.authorizedPendingMigrations)}`);
    }
    const authority = repositoryAuthority || {};
    if (authority.clean !== true) reasons.push('repository worktree is not clean');
    if (authority.recordTracked !== true) reasons.push(`authorization record is not tracked at ${RECORD_RELATIVE_PATH}`);
    if (authority.head !== authority.freshRemoteMaster) {
      reasons.push(`repository HEAD ${authority.head} != freshly queried origin refs/heads/master ${authority.freshRemoteMaster}`);
    }
    if (authority.baselineIsAncestor !== true) {
      reasons.push(`authorizedBaselineHead ${record.authorizedBaselineHead} is not an ancestor of HEAD`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function runGit(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    // Sanitized: git stderr/stdout are never surfaced — transport/helper errors
    // can embed credential material; refusals report only the command shape
    // and exit status.
    const detail = error && typeof error.status === 'number' ? `exit code ${error.status}` : 'failed';
    throw new MigrationExecutionAuthorityError([
      `git ${args[0]} ${detail} — repository authority could not be established`
    ]);
  }
}

// Pure: parses `git ls-remote --exit-code origin refs/heads/master` output.
// Requires exactly one well-formed "<40-hex>\trefs/heads/master" line; empty,
// malformed, wrong-ref, or ambiguous output refuses.
function parseFreshRemoteOutput(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) {
    throw new MigrationExecutionAuthorityError([
      `fresh canonical master query returned no refs/heads/master (${FRESH_REMOTE_COMMAND})`
    ]);
  }
  const shas = [];
  for (const line of lines) {
    const match = FRESH_REMOTE_LINE.exec(line);
    if (!match) {
      throw new MigrationExecutionAuthorityError([
        `fresh canonical master query returned unexpected output and was refused (${FRESH_REMOTE_COMMAND})`
      ]);
    }
    shas.push(match[1]);
  }
  if (shas.length > 1) {
    throw new MigrationExecutionAuthorityError([
      `fresh canonical master query returned ambiguous refs/heads/master results (${FRESH_REMOTE_COMMAND})`
    ]);
  }
  return shas[0];
}

function freshRemoteMasterSha(repoRoot) {
  const stdout = runGit(repoRoot, [...FRESH_REMOTE_ARGS]);
  return parseFreshRemoteOutput(stdout);
}

// Read-only database observation. Never creates the schema or ledger; missing
// state is reported as missing so a fresh non-disposable bootstrap requires an
// exact AUTHORIZED bootstrap transition.
async function observeAppliedMigrationState(client, { schema, schemaSql }) {
  const databaseName = (await client.query('SELECT current_database() AS name')).rows[0].name;
  const schemaRow = await client.query(
    'SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1',
    [schema]
  );
  const schemaExists = schemaRow.rowCount > 0;
  let ledgerExists = false;
  let appliedVersions = [];
  if (schemaExists) {
    const ledger = await client.query('SELECT to_regclass($1) AS name', [`${schema}.schema_migrations`]);
    ledgerExists = Boolean(ledger.rows[0] && ledger.rows[0].name !== null);
    if (ledgerExists) {
      const rows = await client.query(`SELECT version FROM ${schemaSql}."schema_migrations"`);
      appliedVersions = rows.rows.map(row => row.version);
    }
  }
  return { databaseName, schemaExists, ledgerExists, appliedVersions };
}

// Store-facing gate. Throws before any migration mutation when any authority
// predicate fails. Read-only database observation must already have happened;
// the caller passes its results in.
async function enforceMigrationExecutionAuthority({
  repoRoot,
  connectionString,
  schema,
  currentDatabaseName,
  migrations,
  migrationChecksum,
  appliedVersions,
  pendingMigrations,
  readFile,
  loadRecordRaw
}) {
  const readRecord = loadRecordRaw || (() => {
    const fs = require('fs');
    const path = require('path');
    const recordPath = path.join(repoRoot, RECORD_RELATIVE_PATH);
    if (!fs.existsSync(recordPath)) return null;
    return fs.readFileSync(recordPath, 'utf8');
  });
  const checksum = migrationChecksum;
  const raw = readRecord();
  const record = validateRecordShape(raw);

  let configuredTarget;
  try {
    configuredTarget = parseTargetIdentity(connectionString);
  } catch (error) {
    throw new MigrationExecutionAuthorityError([error.message]);
  }
  if (configuredTarget.database !== currentDatabaseName) {
    throw new MigrationExecutionAuthorityError([
      `on-contact database "${currentDatabaseName}" != configured target database "${configuredTarget.database}"`
    ]);
  }
  const observedTarget = Object.freeze({
    host: configuredTarget.host,
    port: configuredTarget.port,
    database: currentDatabaseName,
    schema
  });

  const head = runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
  if (!COMMIT_HEX.test(head)) {
    throw new MigrationExecutionAuthorityError(['repository HEAD is not a 40-hex commit id']);
  }
  const freshRemoteMaster = freshRemoteMasterSha(repoRoot);
  const status = runGit(repoRoot, ['status', '--porcelain']);
  const clean = status.trim().length === 0;
  let recordTracked = true;
  try {
    runGit(repoRoot, ['ls-files', '--error-unmatch', '--', RECORD_RELATIVE_PATH]);
  } catch (error) {
    if (error instanceof MigrationExecutionAuthorityError) recordTracked = false;
    else throw error;
  }
  let baselineIsAncestor = true;
  try {
    runGit(repoRoot, ['merge-base', '--is-ancestor', record.authorizedBaselineHead, head]);
  } catch (error) {
    if (error instanceof MigrationExecutionAuthorityError) baselineIsAncestor = false;
    else throw error;
  }

  const evaluation = evaluateTransition({
    record,
    observedTarget,
    appliedVersions: canonicalizeAppliedVersions(appliedVersions, migrations),
    pendingMigrations,
    repositoryAuthority: {
      clean,
      recordTracked,
      head,
      freshRemoteMaster,
      baselineIsAncestor
    }
  });
  if (!evaluation.ok) {
    throw new MigrationExecutionAuthorityError(evaluation.reasons);
  }
  return Object.freeze({
    migrationTransitionId: record.migrationTransitionId,
    authorizedPendingMigrations: Object.freeze(pendingMigrations.map(entry => Object.freeze({ ...entry })))
  });
}

// Pure: predecessor-equivalent READ-ONLY validation of already-applied
// migration identities on a fully current ledger. Mirrors the mutation
// engine's row-oriented schema_migration_identities checks and
// prepareRuntimePersistence's currency semantics (missing row, changed applied
// bytes, or a row for a version absent from the canonical repository migration
// set all refuse, using the predecessor's own terminology) without mutating
// anything.
function evaluateAppliedMigrationIdentities(identityRows, migrations, migrationChecksum) {
  const reasons = [];
  const identityByVersion = new Map(
    (identityRows || []).map(row => [row.version, row.sha256])
  );
  for (const version of migrations) {
    const stored = identityByVersion.get(version);
    if (stored === undefined) {
      reasons.push(`missing migration identity for applied ${version}`);
      continue;
    }
    if (stored !== migrationChecksum(version)) {
      reasons.push(`historical migration identity changed: ${version}`);
    }
  }
  for (const row of identityRows || []) {
    if (!migrations.includes(row.version)) {
      reasons.push(`historical migration identity changed: ${row.version}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// Read-only database check for the fully-current no-op path. The identities
// ledger is created by migration 031, so a fully current ledger always has it;
// absence refuses (consistent with the mutation engine's identity sync and
// prepareRuntimePersistence's required-relations check) instead of inventing
// semantics for an incomplete identity state.
async function assertAppliedMigrationIdentitiesCurrent(client, { schema, schemaSql, migrations, migrationChecksum }) {
  const identityTable = await client.query(
    'SELECT to_regclass($1) AS name',
    [`${schema}.schema_migration_identities`]
  );
  if (!identityTable.rows[0] || identityTable.rows[0].name === null) {
    return {
      ok: false,
      reasons: ['migration identity ledger schema_migration_identities is absent on a fully current schema']
    };
  }
  const rows = (await client.query(`SELECT version, sha256 FROM ${schemaSql}."schema_migration_identities"`)).rows;
  return evaluateAppliedMigrationIdentities(rows, migrations, migrationChecksum);
}

module.exports = {
  RECORD_RELATIVE_PATH,
  RECORD_KIND,
  RECORD_VERSION,
  AUTHORIZED,
  NOT_AUTHORIZED,
  MigrationExecutionAuthorityError,
  parseTargetIdentity,
  validateRecordShape,
  canonicalizeAppliedVersions,
  computePendingMigrations,
  isFullyCurrentCanonicalLedger,
  evaluateAppliedMigrationIdentities,
  assertAppliedMigrationIdentitiesCurrent,
  evaluateTransition,
  isRfc3339Timestamp,
  parseFreshRemoteOutput,
  freshRemoteMasterSha,
  observeAppliedMigrationState,
  enforceMigrationExecutionAuthority
};
