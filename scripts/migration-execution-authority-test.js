#!/usr/bin/env node
'use strict';

// Deterministic verification for the migration execution-authority contract
// (T10 prevention). PURE ONLY: no PostgreSQL contact, no git network queries,
// no operational contact. Repository/git behavior is covered by fixture-based
// predicate tests plus static source-order assertions; the real proof of
// live behavior is a later independently reviewed operational preflight.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  PostgresRuntimeStore
} = require('../persistence/postgres/store');
const {
  MigrationExecutionAuthorityError,
  NOT_AUTHORIZED,
  isRfc3339Timestamp,
  parseTargetIdentity,
  parseFreshRemoteOutput,
  validateRecordShape,
  canonicalizeAppliedVersions,
  computePendingMigrations,
  isFullyCurrentCanonicalLedger,
  evaluateAppliedMigrationIdentities,
  evaluateTransition
} = require('../persistence/postgres/migration-authority');

const ROOT = path.join(__dirname, '..');

// Fixture lineage: the historical 040 → [041, 042] counterfactual.
const MIGRATIONS = [
  '039_ticket_attempt_authority.sql',
  '040_ticket_cancellation_authority.sql',
  '041_ticket_five_state_cutover.sql',
  '042_objective_revision_baseline.sql'
];
const checksum = version => crypto.createHash('sha256').update(`fixture:${version}`).digest('hex');
const APPLIED_THROUGH_040 = MIGRATIONS.slice(0, 2);
const PENDING_041_042 = MIGRATIONS.slice(2).map(version => ({ version, sha256: checksum(version) }));
const TARGET = { host: '127.0.0.1', port: 5432, database: 'ticket_system', schema: 'ticket_system' };
const HEAD = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);
const PHASE_A_OK = Object.freeze({
  clean: true,
  recordTracked: true,
  head: HEAD,
  freshRemoteMaster: HEAD,
  baselineIsAncestor: true
});

function authorizedRecord(overrides = {}) {
  return {
    recordKind: 'migration-execution-authorization',
    recordVersion: 1,
    migrationTransitionId: '040-to-042',
    authorizationState: 'AUTHORIZED',
    expectedTarget: { ...TARGET },
    requiredAppliedVersions: [...APPLIED_THROUGH_040],
    authorizedPendingMigrations: PENDING_041_042.map(entry => ({ ...entry })),
    authorizedBaselineHead: BASELINE,
    authorizedBy: 'fixture independent authorizing review',
    authorizedAtUtc: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function evaluate(record, overrides = {}) {
  return evaluateTransition({
    record,
    observedTarget: overrides.observedTarget || { ...TARGET },
    appliedVersions: overrides.appliedVersions || [...APPLIED_THROUGH_040],
    pendingMigrations: overrides.pendingMigrations || PENDING_041_042.map(entry => ({ ...entry })),
    repositoryAuthority: overrides.repositoryAuthority || { ...PHASE_A_OK }
  });
}

function expectRefusal(fn, fragment) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MigrationExecutionAuthorityError,
      `wrong error type: ${error && error.message}`);
    if (fragment) {
      assert.ok(error.reasons.some(reason => reason.includes(fragment)),
        `refusal reasons lacked "${fragment}": ${JSON.stringify(error.reasons)}`);
    }
    return error.reasons;
  }
  assert.fail('expected authority refusal');
}

let assertions = 0;
function ok(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

// ── Canonical shipped record ────────────────────────────────────────────────
{
  const raw = fs.readFileSync(path.join(ROOT, 'config', 'migration-execution-authorization.json'), 'utf8');
  const record = validateRecordShape(raw);
  ok(record.authorizationState === NOT_AUTHORIZED, 'shipped record must be NOT_AUTHORIZED');
  ok(record.migrationTransitionId === null, 'NOT_AUTHORIZED transitionId null');
  ok(JSON.stringify(record.expectedTarget) === JSON.stringify({ host: null, port: null, database: null, schema: null }),
    'NOT_AUTHORIZED target fully null');
  ok(JSON.stringify(record.requiredAppliedVersions) === '[]', 'NOT_AUTHORIZED requiredAppliedVersions empty');
  ok(JSON.stringify(record.authorizedPendingMigrations) === '[]', 'NOT_AUTHORIZED authorizedPendingMigrations empty');
  ok(record.authorizedBaselineHead === null && record.authorizedBy === null && record.authorizedAtUtc === null,
    'NOT_AUTHORIZATION carries no authority fields');
  const evaluation = evaluate(record);
  ok(evaluation.ok === false, 'NOT_AUTHORIZED record refuses any transition');
}

// ── Record shape ────────────────────────────────────────────────────────────
ok(validateRecordShape(JSON.stringify(authorizedRecord())).recordKind === 'migration-execution-authorization',
  'exact AUTHORIZED fixture validates');
expectRefusal(() => validateRecordShape(JSON.stringify({
  ...authorizedRecord(), unexpectedField: true
})), 'unknown field');
{
  const partial = { ...authorizedRecord() };
  delete partial.authorizedBy;
  expectRefusal(() => validateRecordShape(JSON.stringify(partial)), 'missing field "authorizedBy"');
}
ok(validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-08-30T21:50:02Z' }))).authorizedAtUtc ===
  '2026-08-30T21:50:02Z', 'valid RFC3339 authorizedAtUtc validates');
ok(validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-08-30T21:50:02.123Z' }))).authorizedAtUtc ===
  '2026-08-30T21:50:02.123Z', 'fractional-second RFC3339 authorizedAtUtc validates');
ok(validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-08-30T21:50:02+02:00' }))).authorizedAtUtc ===
  '2026-08-30T21:50:02+02:00', 'numeric-offset RFC3339 authorizedAtUtc validates');
ok(validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2024-02-29T00:00:00Z' }))).authorizedAtUtc ===
  '2024-02-29T00:00:00Z', 'leap-day 2024-02-29 validates');
ok(validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-04-30T23:59:59Z' }))).authorizedAtUtc ===
  '2026-04-30T23:59:59Z', 'April 30 with 23:59:59 validates');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: 'yesterday' }))), 'RFC3339');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-08-30' }))), 'RFC3339');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-08-30T21:50:02' }))), 'RFC3339');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-13-01T00:00:00Z' }))), 'RFC3339');
// Explicit component validation is used instead of Date.parse because
// JavaScript date parsing normalizes some impossible day-of-month values into
// finite timestamps; no test may depend on that runtime behavior.
ok(isRfc3339Timestamp('2026-02-30T21:50:02Z') === false,
  'repository validator REFUSES 2026-02-30T21:50:02Z');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-02-30T21:50:02Z' }))), 'RFC3339');
ok(isRfc3339Timestamp('2026-02-29T00:00:00Z') === false, '2026-02-29 refuses (2026 is not a leap year)');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-02-29T00:00:00Z' }))), 'RFC3339');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-04-31T00:00:00Z' }))), 'RFC3339');
ok(isRfc3339Timestamp('2026-08-30T24:00:00Z') === false, 'hour 24 refuses');
ok(isRfc3339Timestamp('2026-08-30T21:60:00Z') === false, 'minute 60 refuses');
ok(isRfc3339Timestamp('2026-08-30T21:50:60Z') === false,
  'second 60 refuses (repository convention: no leap-second validation semantics)');
ok(isRfc3339Timestamp('2026-08-30T21:50:02+24:00') === false, 'offset hour 24 refuses');
ok(isRfc3339Timestamp('2026-08-30T21:50:02+02:60') === false, 'offset minute 60 refuses');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedAtUtc: '2026-08-30T21:50:02+24:00' }))), 'RFC3339');
expectRefusal(() => validateRecordShape('{not json'), 'not valid JSON');
expectRefusal(() => validateRecordShape('[]'), 'not a JSON object');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ recordVersion: 2 }))), 'recordVersion');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ recordKind: 'other' }))), 'recordKind');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  authorizationState: 'MAYBE'
}))), 'authorizationState');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  expectedTarget: { ...TARGET, port: '5432' }
}))), 'port');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  expectedTarget: { host: TARGET.host, port: TARGET.port, database: TARGET.database }
}))), 'expectedTarget fields');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  requiredAppliedVersions: ['039_ticket_attempt_authority.sql', '039_ticket_attempt_authority.sql']
}))), 'duplicate versions');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  requiredAppliedVersions: ['not-a-version']
}))), 'canonical migration version');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  authorizedPendingMigrations: [{ version: '041_ticket_five_state_cutover.sql', sha256: 'nothex' }]
}))), 'sha256 hex digest');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  authorizedPendingMigrations: []
}))), 'non-empty pending migration set');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  authorizedPendingMigrations: [{ version: '041_ticket_five_state_cutover.sql' }]
}))), 'exactly version/sha256');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  authorizedBaselineHead: 'nothex'
}))), '40-hex commit id');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({ authorizedBy: '' }))), 'authorizedBy');
expectRefusal(() => validateRecordShape(JSON.stringify(authorizedRecord({
  migrationTransitionId: null
}))), 'migrationTransitionId');

// ── Target identity parsing (non-secret) ────────────────────────────────────
{
  const parsed = parseTargetIdentity('postgresql://ticket_system:secret@127.0.0.1:5432/ticket_system');
  ok(JSON.stringify(Object.keys(parsed)) === JSON.stringify(['host', 'port', 'database']),
    'parsed target exposes only non-secret identity fields');
  ok(parsed.host === '127.0.0.1' && parsed.port === 5432 && parsed.database === 'ticket_system',
    'bundled operational target parses');
  ok(parseTargetIdentity('postgresql://u:p@db.example.internal/ticket_system').port === 5432,
    'default port 5432');
  assert.throws(() => parseTargetIdentity('not a url'), TypeError, 'malformed URL');
  assert.throws(() => parseTargetIdentity('mysql://u:p@127.0.0.1/ticket_system'), TypeError, 'foreign scheme');
  assert.throws(() => parseTargetIdentity('postgresql://u:p@127.0.0.1:5432/'), TypeError, 'missing database');
  assert.throws(() => parseTargetIdentity(null), TypeError, 'unavailable target refuses');
}

// ── Transition evaluation: 040 → [041, 042] counterfactual ─────────────────
{
  const admission = evaluate(authorizedRecord());
  ok(admission.ok, `exact authorized transition admits at guard-contract level: ${JSON.stringify(admission.reasons)}`);
}
ok(evaluate(authorizedRecord({ authorizationState: NOT_AUTHORIZED })).ok === false, 'NOT_AUTHORIZED refuses');
ok(evaluate(authorizedRecord()).reasons.length === 0,
  'exact authorized transition admits with zero refusal reasons');
ok(evaluate(authorizedRecord({
  authorizedPendingMigrations: PENDING_041_042.slice(0, 1).map(entry => ({ ...entry }))
})).ok === false, 'pending subset refuses');
ok(evaluate(authorizedRecord({
  authorizedPendingMigrations: [...PENDING_041_042, { version: '043_future.sql', sha256: checksum('043_future.sql') }]
})).ok === false, 'pending superset refuses');
ok(evaluate(authorizedRecord({
  authorizedPendingMigrations: [...PENDING_041_042].reverse()
})).ok === false, 'pending order mismatch refuses');
ok(evaluate(authorizedRecord({
  authorizedPendingMigrations: [PENDING_041_042[0], { ...PENDING_041_042[1], sha256: checksum('tampered') }]
})).ok === false, 'changed pending source bytes refuse');
ok(evaluate(authorizedRecord({
  requiredAppliedVersions: MIGRATIONS.slice(0, 1)
})).ok === false, 'wrong applied pre-state (038) refuses');
ok(evaluate(authorizedRecord({
  requiredAppliedVersions: MIGRATIONS.slice(0, 3)
})).ok === false, 'wrong applied pre-state (through 041) refuses');
ok(evaluate(authorizedRecord({
  requiredAppliedVersions: [...MIGRATIONS]
})).ok === false, 'stale authorization reuse after transition refuses');
for (const field of ['host', 'port', 'database', 'schema']) {
  const observed = { ...TARGET };
  observed[field] = field === 'port' ? 5433 : 'other';
  const reasons = evaluate(authorizedRecord(), { observedTarget: observed });
  ok(reasons.ok === false && reasons.reasons.some(reason => reason.includes(`target ${field}`)),
    `cross-target replay refuses on ${field}`);
}
{
  const dirty = evaluate(authorizedRecord(), { repositoryAuthority: { ...PHASE_A_OK, clean: false } });
  ok(dirty.ok === false && dirty.reasons.some(reason => reason.includes('not clean')), 'dirty repository refuses');
  ok(dirty.reasons.every(reason => reason.includes('not clean')),
    'dirty-tree refusal cites only the clean-tree predicate');
}
{
  const reasons = evaluate(authorizedRecord(), {
    repositoryAuthority: { ...PHASE_A_OK, freshRemoteMaster: 'c'.repeat(40) }
  });
  ok(reasons.ok === false && reasons.reasons.some(reason => reason.includes('freshly queried origin refs/heads/master')),
    'HEAD != fresh canonical master refuses');
}
{
  const reasons = evaluate(authorizedRecord(), {
    repositoryAuthority: { ...PHASE_A_OK, recordTracked: false }
  });
  ok(reasons.ok === false && reasons.reasons.some(reason => reason.includes('not tracked')),
    'untracked authorization record refuses');
}
{
  const reasons = evaluate(authorizedRecord(), {
    repositoryAuthority: { ...PHASE_A_OK, baselineIsAncestor: false }
  });
  ok(reasons.ok === false && reasons.reasons.some(reason => reason.includes('not an ancestor')),
    'baseline ancestry failure refuses');
}

// ── Fresh remote output parsing (pure) ──────────────────────────────────────
ok(parseFreshRemoteOutput(`${HEAD}\trefs/heads/master\n`) === HEAD, 'single valid ref parses');
ok(parseFreshRemoteOutput(`${HEAD}\trefs/heads/master`) === HEAD, 'line without trailing newline parses');
expectRefusal(() => parseFreshRemoteOutput(''), 'no refs/heads/master');
expectRefusal(() => parseFreshRemoteOutput('\n  \n'), 'no refs/heads/master');
expectRefusal(() => parseFreshRemoteOutput('zz123\trefs/heads/master\n'), 'unexpected output');
expectRefusal(() => parseFreshRemoteOutput(`${HEAD} refs/heads/master\n`), 'unexpected output');
expectRefusal(() => parseFreshRemoteOutput(`${HEAD}\trefs/heads/main\n`), 'unexpected output');
expectRefusal(() => parseFreshRemoteOutput(`${HEAD}\trefs/heads/master extra\n`), 'unexpected output');
expectRefusal(() => parseFreshRemoteOutput(`${HEAD}\trefs/heads/master\n${HEAD}\trefs/heads/master\n`), 'ambiguous');

// ── Applied/pending canonicalization and fully-current detection ────────────
ok(JSON.stringify(canonicalizeAppliedVersions(['040_ticket_cancellation_authority.sql', '039_ticket_attempt_authority.sql'], MIGRATIONS)) ===
  JSON.stringify(APPLIED_THROUGH_040), 'applied versions canonicalize to repository order');
{
  const stray = [...MIGRATIONS, '999_stray_history.sql'];
  const ordered = canonicalizeAppliedVersions(stray, MIGRATIONS);
  ok(ordered[ordered.length - 1] === '999_stray_history.sql', 'unknown/stray versions sort last');
}
ok(JSON.stringify(computePendingMigrations(APPLIED_THROUGH_040, MIGRATIONS, checksum)) === JSON.stringify(PENDING_041_042),
  'pending set derives deterministically with source sha256');
ok(JSON.stringify(computePendingMigrations(MIGRATIONS, MIGRATIONS, checksum)) === '[]', 'fully current pending is empty');
ok(isFullyCurrentCanonicalLedger([...MIGRATIONS], MIGRATIONS), 'exact canonical ledger is fully current');
ok(!isFullyCurrentCanonicalLedger(MIGRATIONS.slice(0, 3), MIGRATIONS), 'missing head is not fully current');
ok(!isFullyCurrentCanonicalLedger([...MIGRATIONS, '999_stray_history.sql'], MIGRATIONS),
  'stray history is not fully current (no mutation-free no-op over strays)');

// ── Fully-current identity-drift detection (read-only, predecessor-equivalent)
{
  const current = evaluateAppliedMigrationIdentities(
    MIGRATIONS.map(version => ({ version, sha256: checksum(version) })), MIGRATIONS, checksum);
  ok(current.ok, 'fully current + matching identity bytes validates read-only');
}
{
  const drifted = evaluateAppliedMigrationIdentities(
    MIGRATIONS.map(version => ({ version, sha256: checksum(version) })), MIGRATIONS,
    version => (version === '041_ticket_five_state_cutover.sql' ? checksum('changed-bytes') : checksum(version)));
  ok(drifted.ok === false &&
     drifted.reasons.some(reason => reason.includes('historical migration identity changed: 041_ticket_five_state_cutover.sql')),
    'changed already-applied migration bytes refuse on the fully-current path');
  ok(drifted.reasons.every(reason => reason.includes('041_ticket_five_state_cutover.sql')),
    'identity-drift refusal names exactly the drifted migration');
}
{
  const drifted = evaluateAppliedMigrationIdentities(
    MIGRATIONS.filter(version => version !== '042_objective_revision_baseline.sql')
      .map(version => ({ version, sha256: checksum(version) })), MIGRATIONS, checksum);
  ok(drifted.ok === false &&
     drifted.reasons.some(reason => reason.includes('missing migration identity for applied 042_objective_revision_baseline.sql')),
    'incomplete identity ledger refuses (predecessor currency semantics)');
}
{
  const emptyLedger = evaluateAppliedMigrationIdentities([], MIGRATIONS, checksum);
  ok(emptyLedger.ok === false && emptyLedger.reasons.length === MIGRATIONS.length,
    'absent identity rows refuse every applied version (absent-table semantics)');
}
{
  const stray = evaluateAppliedMigrationIdentities(
    [...MIGRATIONS.map(version => ({ version, sha256: checksum(version) })),
     { version: '999_stray_history.sql', sha256: checksum('999_stray_history.sql') }],
    MIGRATIONS, checksum);
  ok(stray.ok === false &&
     stray.reasons.some(reason => reason.includes('historical migration identity changed: 999_stray_history.sql')),
    'stray/noncanonical identity row refuses, identifying the stray version');
  ok(stray.reasons.filter(reason => reason.includes('999_stray_history.sql')).length === 1,
    'exactly one refusal reason identifies the stray identity row');
}

// ── Static executor/source assertions (no DB) ───────────────────────────────
{
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence/postgres/store.js'), 'utf8');
  const migrateIndex = storeSource.indexOf('  async migrate() {');
  const runMigrationsIndex = storeSource.indexOf('  async _runMigrations() {');
  const guardIndex = storeSource.indexOf('migrationAuthority.observeAppliedMigrationState');
  const enforcementIndex = storeSource.indexOf('migrationAuthority.enforceMigrationExecutionAuthority');
  const lockIndex = storeSource.indexOf('pg_advisory_lock');
  const createSchemaIndex = storeSource.indexOf('CREATE SCHEMA IF NOT EXISTS');
  ok(migrateIndex !== -1 && runMigrationsIndex > migrateIndex, 'migrate() delegates mutation to _runMigrations()');
  ok(guardIndex > migrateIndex && guardIndex < runMigrationsIndex, 'guarded observation lives in migrate(), before the engine');
  ok(enforcementIndex > migrateIndex && enforcementIndex < runMigrationsIndex, 'authority enforcement runs before the mutation engine');
  ok(lockIndex > runMigrationsIndex && createSchemaIndex > runMigrationsIndex,
    'advisory lock and CREATE SCHEMA remain inside the mutation engine behind the guard');
  ok(/disposableMigrations === true/.test(storeSource.slice(migrateIndex, guardIndex)),
    'disposable declaration short-circuits to the legacy engine path before any guard DB contact');
  const fullyCurrentStart = storeSource.indexOf('isFullyCurrentCanonicalLedger(appliedVersions, migrations)');
  const fullyCurrentSlice = storeSource.slice(fullyCurrentStart, storeSource.indexOf('return [];', fullyCurrentStart));
  ok(fullyCurrentSlice.includes('assertAppliedMigrationIdentitiesCurrent'),
    'fully-current path performs read-only identity validation before the no-op return');
  ok(fullyCurrentSlice.includes('MigrationExecutionAuthorityError'),
    'fully-current identity drift refuses fail-closed before the no-op return');
  ok(!fullyCurrentSlice.includes('pg_advisory_lock') &&
     !fullyCurrentSlice.includes('CREATE SCHEMA') &&
     !fullyCurrentSlice.includes('INSERT INTO') &&
     !fullyCurrentSlice.includes('_runMigrations()'),
    'fully-current identity validation and no-op remain mutation-free');
  const defaultGuarded = new PostgresRuntimeStore({ connectionString: 'postgresql://u:p@127.0.0.1:5432/ticket_system' });
  ok(defaultGuarded.disposableMigrations === false, 'default store construction remains guarded');
  const harnessSource = fs.readFileSync(path.join(ROOT, 'scripts/postgres-test-harness.js'), 'utf8');
  ok(harnessSource.includes('disposableMigrations: true'),
    'canonical disposable harness explicitly declares disposable migration stores');
  ok(/disposableMigrations = false/.test(storeSource), 'default store construction remains guarded');
}

console.log(`\nPASS: migration execution-authority contract — ${assertions} assertions (pure; no database contact)`);
