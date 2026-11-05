#!/usr/bin/env node
'use strict';

// Deterministic verification for the migration execution-authority contract
// (T10 prevention). PURE ONLY: no PostgreSQL contact, no git network queries,
// no operational contact. Repository/git behavior is covered by fixture-based
// predicate tests plus static source-order assertions; the real proof of
// live behavior is a later independently reviewed operational preflight.
// The canonical tracked record verifies state-adaptively from its own
// authorizationState alone (see the canonical-record section below).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  PostgresRuntimeStore,
  migrationChecksum,
  migrationFiles
} = require('../persistence/postgres/store');
const {
  AUTHORIZED,
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

// ── Canonical tracked record (state-adaptive) ───────────────────────────────
// The tracked canonical record selects its own verification branch from
// authorizationState alone — no CLI flag, environment variable, or hidden
// override exists. NOT_AUTHORIZED is the exact fail-closed resting state
// authorizing nothing. AUTHORIZED is the bounded operational-transition
// state: the branch proves, from tracked repository bytes only (no database,
// no network, no git subprocess), that the record binds exactly one real,
// byte-coherent canonical transition before publication. Execution-time
// predicates (clean tree, tracked record, HEAD == freshly queried origin
// master, baseline ancestry, observed target/pre-state/pending equality)
// remain owned by enforceMigrationExecutionAuthority and are unchanged.
{
  const raw = fs.readFileSync(path.join(ROOT, 'config', 'migration-execution-authorization.json'), 'utf8');
  const record = validateRecordShape(raw);
  if (record.authorizationState === NOT_AUTHORIZED) {
    ok(record.migrationTransitionId === null, 'NOT_AUTHORIZED transitionId null');
    ok(JSON.stringify(record.expectedTarget) === JSON.stringify({ host: null, port: null, database: null, schema: null }),
      'NOT_AUTHORIZED target fully null');
    ok(JSON.stringify(record.requiredAppliedVersions) === '[]', 'NOT_AUTHORIZED requiredAppliedVersions empty');
    ok(JSON.stringify(record.authorizedPendingMigrations) === '[]', 'NOT_AUTHORIZED authorizedPendingMigrations empty');
    ok(record.authorizedBaselineHead === null && record.authorizedBy === null && record.authorizedAtUtc === null,
      'NOT_AUTHORIZATION carries no authority fields');
    const evaluation = evaluate(record);
    ok(evaluation.ok === false, 'NOT_AUTHORIZED record refuses any transition');
  } else if (record.authorizationState === AUTHORIZED) {
    // Canonical migration source: migrationFiles() enforces the repository's
    // canonical filename/order/prefix rules; migrationChecksum() hashes the
    // exact tracked migration bytes.
    const canonicalMigrations = migrationFiles();
    const pendingEntries = record.authorizedPendingMigrations;
    for (const entry of pendingEntries) {
      ok(canonicalMigrations.includes(entry.version),
        `authorized pending migration ${entry.version} exists in canonical migration source`);
      ok(entry.sha256 === migrationChecksum(entry.version),
        `authorized sha256 for ${entry.version} exactly matches canonical migration file bytes`);
    }
    for (const version of record.requiredAppliedVersions) {
      ok(canonicalMigrations.includes(version),
        `required applied migration ${version} exists in canonical migration source`);
    }
    ok(JSON.stringify([...record.requiredAppliedVersions, ...pendingEntries.map(entry => entry.version)]) ===
      JSON.stringify(canonicalMigrations),
      'requiredAppliedVersions + authorizedPendingMigrations compose the canonical migration order exactly');
    ok(JSON.stringify(computePendingMigrations(record.requiredAppliedVersions, canonicalMigrations, migrationChecksum)) ===
      JSON.stringify(pendingEntries),
      'canonical pending set derived from requiredAppliedVersions exactly equals authorizedPendingMigrations');
    // The record admits the exact bound transition through the
    // repository-owned pure evaluator under an exact matching fixture.
    const liveInputs = () => ({
      observedTarget: { ...record.expectedTarget },
      appliedVersions: [...record.requiredAppliedVersions],
      pendingMigrations: pendingEntries.map(entry => ({ ...entry }))
    });
    const evaluateBound = (recordVariant, overrides = {}) =>
      evaluate(recordVariant, { ...liveInputs(), ...overrides });
    const admission = evaluateBound(record);
    ok(admission.ok, `AUTHORIZED record admits the exact bound transition: ${JSON.stringify(admission.reasons)}`);
    // Exact-binding perturbations refuse (mechanism-owned dimensions).
    for (const field of ['host', 'port', 'database', 'schema']) {
      const observed = { ...record.expectedTarget };
      observed[field] = field === 'port' ? record.expectedTarget.port + 1 : `${record.expectedTarget[field]}-perturbed`;
      const result = evaluateBound(record, { observedTarget: observed });
      ok(result.ok === false && result.reasons.some(reason => reason.includes(`target ${field}`)),
        `cross-target replay refuses on ${field}`);
    }
    ok(evaluateBound(record, {
      appliedVersions: [...record.requiredAppliedVersions, '999_stray_history.sql']
    }).ok === false, 'superset applied pre-state refuses');
    if (record.requiredAppliedVersions.length > 0) {
      ok(evaluateBound(record, { appliedVersions: record.requiredAppliedVersions.slice(1) }).ok === false,
        'missing applied pre-state head refuses');
    }
    if (record.requiredAppliedVersions.length >= 2) {
      ok(evaluateBound(record, { appliedVersions: [...record.requiredAppliedVersions].reverse() }).ok === false,
        'reordered applied pre-state refuses');
    }
    ok(evaluateBound(record, { pendingMigrations: pendingEntries.slice(0, -1) }).ok === false,
      'pending subset refuses');
    ok(evaluateBound(record, { pendingMigrations: [...pendingEntries,
      { version: '999_stray_future.sql', sha256: checksum('999_stray_future.sql') }] }).ok === false,
      'pending superset refuses');
    if (pendingEntries.length >= 2) {
      ok(evaluateBound(record, { pendingMigrations: [...pendingEntries].reverse() }).ok === false,
        'pending order mismatch refuses');
    }
    ok(evaluateBound({ ...record, authorizedPendingMigrations: pendingEntries.map((entry, index) => index === 0
      ? { ...entry, sha256: checksum('tampered-bytes') } : { ...entry }) }).ok === false,
      'changed authorized pending source bytes refuse');
    ok(evaluateBound({ ...record, authorizedPendingMigrations: pendingEntries.map((entry, index) => index === 0
      ? { version: '999_stray_future.sql', sha256: checksum('999_stray_future.sql') } : { ...entry }) }).ok === false,
      'non-canonical authorized pending version refuses');
    ok(evaluateBound({ ...record, requiredAppliedVersions: [...canonicalMigrations] }).ok === false,
      'stale authorization reuse after transition refuses');
    ok(evaluateBound({ ...record, authorizationState: NOT_AUTHORIZED }).ok === false,
      'demoted authorization state refuses');
    // Publication-authority predicates remain required for the live record.
    const authorityRefusal = (overrides, fragment, label) => {
      const result = evaluateBound(record, { repositoryAuthority: { ...PHASE_A_OK, ...overrides } });
      ok(result.ok === false && result.reasons.some(reason => reason.includes(fragment)),
        `${label} refuses`);
    };
    authorityRefusal({ clean: false }, 'not clean', 'dirty repository');
    authorityRefusal({ recordTracked: false }, 'not tracked', 'untracked authorization record');
    authorityRefusal({ freshRemoteMaster: 'c'.repeat(40) }, 'freshly queried origin refs/heads/master',
      'HEAD != fresh canonical master');
    authorityRefusal({ baselineIsAncestor: false }, 'not an ancestor', 'baseline ancestry failure');
  } else {
    assert.fail(`tracked record carries non-canonical authorizationState ${JSON.stringify(record.authorizationState)}`);
  }
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

// ── Disposable-development authority surface (P6-DEVEX-A, compose-bound) ────
// Exactly ONE non-test production construction site may grant the code-declared
// disposable migration authority. It is MODULE-INTERNAL to the verified
// development lifecycle owner (scripts/dev-database.js), the bundled compose
// ownership proof lexically AND functionally precedes every construction, the
// destructive create/drop helpers are not exported and cannot redirect the
// identity, and no authority surface is reachable from env alone. All checks
// in this block remain PURE (no compose process, no PostgreSQL contact): the
// functional proof drives the real lifecycle through injected non-identity
// mechanics plus a recording replacement of the store module.
{
  const allowlistDirectories = ['scripts', 'persistence', 'runtime'];
  const extraFiles = ['server.js'];
  const trackedScriptFiles = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'ARCHIVE') continue;
        walk(relative);
      } else if (entry.name.endsWith('.js')) {
        trackedScriptFiles.push(relative);
      }
    }
  };
  for (const directory of allowlistDirectories) walk(directory);

  const disposableConstructionSites = [];
  const guardedConstructionFiles = [];
  for (const relative of [...trackedScriptFiles, ...extraFiles]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    if (!source.includes('new PostgresRuntimeStore(')) continue;
    if (/disposableMigrations\s*:\s*true/.test(source)) {
      disposableConstructionSites.push(relative);
    } else {
      guardedConstructionFiles.push(relative);
    }
  }
  const isDisposableTestSite = file =>
    /-test\.js$/.test(file) || file.endsWith('postgres-test-harness.js');
  const disposableProdSites = disposableConstructionSites.filter(file => !isDisposableTestSite(file));
  ok(JSON.stringify(disposableProdSites) === JSON.stringify(['scripts/dev-database.js']),
    'exactly ONE non-test production file constructs disposable-migration stores: the verified-development lifecycle owner scripts/dev-database.js');
  ok(disposableProdSites.length === 1 &&
     disposableProdSites[0] !== 'scripts/dev-environment.js' &&
     disposableProdSites[0] !== 'server.js',
    'the fixed-identity seam and the server never carry the authority themselves');
  ok(disposableConstructionSites.filter(isDisposableTestSite).length > 0,
    'the already-authorized disposable test/harness construction sites remain intact');
  ok(guardedConstructionFiles.length > 0,
    'the operational construction sites (server, migrate, release) remain on the guarded default');
  ok(guardedConstructionFiles.some(file => file === 'server.js'),
    'server.js never constructs a disposable store');
  ok(guardedConstructionFiles.some(file => file === 'scripts/dev-environment.js'),
    'the fixed development identity seam (dev-environment.js) constructs only guarded stores');

  // 1. Exactly ONE non-test production literal `disposableMigrations: true`,
  //    and 2. that literal lives INSIDE the internal verified-development
  //    lifecycle (module-internal factory, internal target derivation).
  const devDatabaseSource = fs.readFileSync(path.join(ROOT, 'scripts/dev-database.js'), 'utf8');
  ok(devDatabaseSource.split('disposableMigrations: true').length - 1 === 1,
    'exactly ONE disposable-authority literal exists in the development lifecycle owner');
  const factoryStart = devDatabaseSource.indexOf('function createDisposableDevelopmentStore(');
  const factoryEnd = devDatabaseSource.indexOf('function assertFixedDevelopmentIdentity(', factoryStart);
  const factorySlice = devDatabaseSource.slice(factoryStart, factoryEnd);
  ok(factoryStart !== -1 && factoryEnd > factoryStart,
    'the single authority-bearing site is the module-internal factory');
  ok(factorySlice.includes('disposableMigrations: true'),
    'the one site declares disposable migrations explicitly in code');
  ok(factorySlice.includes('disposableDevelopmentTarget(env)'),
    'the development authority site derives the target internally, from fixed constants');
  ok(factorySlice.includes('connectionString: target.databaseUrl'),
    'the connection target comes only from the internally constructed fixed identity');
  ok(!/DATABASE_URL/.test(factorySlice) && !/POSTGRES_SCHEMA/.test(factorySlice),
    'the disposable target consumes NO DATABASE_URL or POSTGRES_SCHEMA identity');

  // 3 + 4. The exported surface: NOTHING returns an authority-bearing store,
  // and no create/drop/reset helper is exported at all. The two high-level
  // lifecycle operations take ZERO arguments: no env handoff, no proof
  // mechanics (process launch, compose file pointer, runtime selection,
  // verification, or client factory), and no target identity can be supplied
  // by a caller — every proof mechanism on the disposable-authority path is
  // module-owned.
  const lifecycleModule = require('./dev-database');
  ok(JSON.stringify(Object.keys(lifecycleModule).sort()) ===
    JSON.stringify(['composeInvocationEnvironment', 'prepareAndMigrateDisposableDevelopmentDatabase', 'resetDisposableDevelopmentDatabase', 'trustedComposeRuntimeExecutablePath']),
    'the exposed surface is exactly the two zero-argument lifecycle operations plus the two PURE test-only classifiers (trusted-executable path assessment and Compose environment sanitation), both non-authority helpers');
  ok(lifecycleModule.prepareAndMigrateDisposableDevelopmentDatabase.length === 0 &&
     lifecycleModule.resetDisposableDevelopmentDatabase.length === 0,
    'both exposed operations declare ZERO parameters — no caller input reaches the proof path');
  for (const forbidden of [
    'createDevelopmentStore',
    'createDisposableDevelopmentStore',
    'ensureDisposableDevelopmentDatabase',
    'destroyDisposableDevelopmentDatabase',
    'migrateDisposableDevelopmentDatabase',
    'prepareDisposableDevelopmentDatabase',
    'startDevelopmentDatabase',
    'selectComposeRuntime',
    'verifyConfiguredDatabase',
    'COMPOSE_FILE',
    'COMPOSE_RUNTIMES',
    'commandSucceeded'
  ]) {
    ok(!(forbidden in lifecycleModule),
      `the lifecycle owner exports no authority surface or proof mechanism (${forbidden} is module-internal)`);
  }
  ok(/function assertFixedDevelopmentIdentity\(env, devTarget, action\)/.test(devDatabaseSource),
    'the module-internal identity gate is named with the exact identity parameters used above');
  const exportedFunctionNames = ['prepareAndMigrateDisposableDevelopmentDatabase', 'resetDisposableDevelopmentDatabase'];
  for (const functionName of exportedFunctionNames) {
    ok(new RegExp(`async function ${functionName}\\(\\)`).test(devDatabaseSource),
      `${functionName} is declared with a ZERO-parameter signature`);
    const functionStart = devDatabaseSource.indexOf(`async function ${functionName}()`);
    const functionBody = devDatabaseSource.slice(functionStart, devDatabaseSource.indexOf('async function', functionStart + 10));
    ok(/\(arguments\.length > 0\)/.test(functionBody) && /accepts no arguments/.test(functionBody),
      `${functionName} refuses ANY argument (authority-affecting or not) before any contact`);
    const argumentGuardHead = functionBody.slice(0, functionBody.indexOf('accepts no arguments') + 1);
    ok(!/(?:applyEnv|spawn|runtime|composeFile|verifyDatabase|clientFactory)\b/.test(argumentGuardHead),
      `${functionName} argument-refusal gate mentions no assembled-option or injected-mechanism surface`);
    ok(!/devTarget|databaseUrl|connectionString|export\b|module\.exports/.test(argumentGuardHead),
      `${functionName} accepts no database URL or target object identity`);
  }
  ok(!/(?:^|[^.\w])(?:applyEnv|composeFile|verifyDatabase|clientFactory)(?![_\w])/.test(devDatabaseSource),
    'the lifecycle owner contains no caller-injectable proof mechanism identifiers anywhere (module-owned mechanics only)');
  const devEnvironmentModule = require('./dev-environment');
  ok(typeof devEnvironmentModule.createDevelopmentStore === 'undefined',
    'the former exported direct-from-env authority helper is GONE');
  ok(typeof devEnvironmentModule.createGuardedDevelopmentStore === 'function',
    'the development seam exposes only the guarded (non-authority) store factory');

  // 5a. LEXICAL ordering/ownership: the compose ownership proof (start +
  // verification) is defined before the authority factory, the factory is
  // constructed from exactly one internal call site, and every reachable flow
  // constructs the authority-bearing store only AFTER its compose-verified
  // lifecycle steps (compose start → verification → destroy/ensure → migrate).
  const composeStartIndex = devDatabaseSource.indexOf('async function startDevelopmentDatabase(');
  const composeVerifyIndex = devDatabaseSource.indexOf('async function verifyConfiguredDatabase(');
  const migrationStepStart = devDatabaseSource.indexOf('async function migrateDisposableDevelopmentDatabase(');
  const prepareFlowStart = devDatabaseSource.indexOf('async function prepareAndMigrateDisposableDevelopmentDatabase(');
  const resetFlowStart = devDatabaseSource.indexOf('async function resetDisposableDevelopmentDatabase(');
  ok(composeStartIndex !== -1 && composeVerifyIndex !== -1 && composeStartIndex < factoryStart,
    'the bundled compose start/verify machinery lexically precedes the authority factory');
  ok(devDatabaseSource.split('createDisposableDevelopmentStore(').length - 1 === 2,
    'the authority factory is reachable from exactly one internal call site (its definition plus the internal migration step)');
  ok(migrationStepStart !== -1 && migrationStepStart > composeVerifyIndex && migrationStepStart < prepareFlowStart,
    'the migration step lives inside the lifecycle owner, after the compose proof machinery');
  ok(devDatabaseSource.split('migrateDisposableDevelopmentDatabase(process.env);').length - 1 === 2,
    'exactly the two exported lifecycle flows invoke the internal migration step');
  {
    const prepareFlowSlice = devDatabaseSource.slice(prepareFlowStart, resetFlowStart);
    const resetFlowSlice = devDatabaseSource.slice(resetFlowStart, devDatabaseSource.indexOf('function printHelp()'));
    const preparePrepare = prepareFlowSlice.indexOf('await prepareDisposableDevelopmentDatabase()');
    const prepareMigrate = prepareFlowSlice.indexOf('migrateDisposableDevelopmentDatabase(process.env)');
    ok(preparePrepare !== -1 && prepareMigrate !== -1 && preparePrepare < prepareMigrate,
      'the prepare+migrate flow lexically runs the compose-verified prepare BEFORE the disposable migration');
    ok(!prepareFlowSlice.includes('createDisposableDevelopmentStore('),
      'the prepare+migrate flow never constructs the authority store directly (always via the compose-verified migration step)');
    const resetCompose = resetFlowSlice.indexOf('await startDevelopmentDatabase()');
    const resetDestroy = resetFlowSlice.indexOf('await destroyDisposableDevelopmentDatabase(process.env, started.devTarget)');
    const resetEnsure = resetFlowSlice.indexOf('await ensureDisposableDevelopmentDatabase(process.env, started.devTarget)');
    const resetMigrate = resetFlowSlice.indexOf('migrateDisposableDevelopmentDatabase(process.env)');
    ok(resetCompose !== -1 && resetDestroy !== -1 && resetEnsure !== -1 && resetMigrate !== -1 &&
       resetCompose < resetDestroy && resetDestroy < resetEnsure && resetEnsure < resetMigrate,
      'the reset flow lexically runs compose start → destroy → ensure → migrate');
    ok(!resetFlowSlice.includes('createDisposableDevelopmentStore('),
      'the reset flow never constructs the authority store directly (always via the compose-verified migration step)');
  }
  // 5b. TRUST-BOUNDARY HONESTY AND SIMPLIFIED DETERMINISTIC COVERAGE.
  //
  // The Compose lifecycle is NOT an adversarial security boundary: application
  // JavaScript cannot constrain an unrestricted principal executing arbitrary
  // code under the same Unix account, and no in-process ceremony would change
  // that. This suite therefore does NOT claim runtime-level adversarial
  // resistance, and the earlier fake-PATH-executable harness is REMOVED:
  // ambient PATH substitution no longer appears as any affirmative proof and
  // cannot even reach the resolved trusted runtime (see the static proof
  // below). Deterministic ownership stays at the layers the application
  // actually owns:
  //
  //   — zero-argument authority exports; any argument refuses before contact;
  //   — module-internal single disposable construction site; no store or
  //     authority surface is exported;
  //   — pure trusted-executable-path classification and Compose environment
  //     sanitation (ambient executable resolution cannot choose the runtime;
  //     runtime/context redirection variables cannot silently redirect the
  //     supported local Compose invocation);
  //   — static ordering: compose preparation precedes disposable-store
  //     construction; the real repository compose.dev.yml and the explicit
  //     local default engine selection are used.
  //
  // The AFFIRMATIVE proof that the ordinary supported local path actually
  // works is the bounded REAL developer smoke against the real system Docker
  // Compose (real launch machinery, real readiness verification, real
  // disposable store migration, real bounded destructive reset).
  ok(/\(arguments\.length > 0\)/.test(devDatabaseSource) === true,
    'the lifecycle owner refuses arguments in code before any contact');
  ok(/(?:\bspawn\s*=|\bcomposeFile\b|\bverifyDatabase\b|\bclientFactory\b|\bapplyEnv\b)/.test(devDatabaseSource) === false,
    'the lifecycle owner has zero caller-mechanism default-value seams anywhere (env defaults appear only on PURE single-argument test helpers, never on the authority path)');
  ok(/const \{ spawnSync \} = require\('child_process'\);/.test(devDatabaseSource),
    'the production Compose launch uses the real module-owned process-launch implementation');
  ok(/process\.env\.PATH|fromPath|envPath|\['PATH'\]|"PATH"/.test(devDatabaseSource) === false,
    'the development lifecycle never resolves the Compose runtime through ambient executable-resolution lookups');
  ok(devDatabaseSource.includes('/usr/bin') && devDatabaseSource.includes('/usr/local/bin') &&
     devDatabaseSource.includes("'--context', 'default'"),
    'the lifecycle resolves only trusted absolute system runtime directories and explicitly selects the local default engine');
  ok(/COMPOSE_UP_EXTRA_ARGS = Object\.freeze\(\['up', '-d', '--wait'\]\)/.test(devDatabaseSource),
    'the bundled compose start arguments are repository-owned constants');

  // Runtime redirection neutralization (PURE, deterministic): the exactly
  // listed Docker/Podman environment channels are stripped for the Compose
  // child process only; the frozen process environment channel
  // (TICKET_SYSTEM_POSTGRES_PORT) passes; unrelated variables survive.
  const sanitizedComposeEnvironment = lifecycleModule.composeInvocationEnvironment({
    DOCKER_HOST: 'tcp://remote-host-attacker-credential:2375',
    DOCKER_CONTEXT: 'remote-attacker-context',
    DOCKER_CONFIG: '/attacker/config-directory',
    COMPOSE_FILE: '/attacker/fake-compose.yml',
    COMPOSE_PROJECT_NAME: 'attacker-project-name',
    DOCKER_CLI_PLUGIN_EXTRA_HINTS: 'irrelevant-value',
    TICKET_SYSTEM_POSTGRES_PORT: '55432',
    PGHOST: '10.9.8.7',
    DATABASE_URL: 'postgresql://operatorial:test-only-password@127.0.0.1:5432/ticket_system'
  });
  ok(sanitizedComposeEnvironment.DOCKER_HOST === undefined &&
     sanitizedComposeEnvironment.DOCKER_CONTEXT === undefined &&
     sanitizedComposeEnvironment.DOCKER_CONFIG === undefined &&
     sanitizedComposeEnvironment.COMPOSE_FILE === undefined &&
     sanitizedComposeEnvironment.COMPOSE_PROJECT_NAME === undefined,
    'the Compose child environment cannot be redirected by Docker/Podman runtime or project-selection variables');
  ok(sanitizedComposeEnvironment.TICKET_SYSTEM_POSTGRES_PORT === '55432' &&
     sanitizedComposeEnvironment.PGHOST === '10.9.8.7' &&
     typeof sanitizedComposeEnvironment.DATABASE_URL === 'string' &&
     sanitizedComposeEnvironment.DATABASE_URL.includes('ticket_system'),
    'the process environment channel the frozen contract permits reaches the compose child; unrelated variables survive');
  ok(JSON.stringify(lifecycleModule.composeInvocationEnvironment({})) === JSON.stringify({}) &&
     lifecycleModule.composeInvocationEnvironment({ FOO: undefined }).FOO === undefined,
    'composeInvocationEnvironment is a pure passthrough for non-redirecting keys (undefined values dropped)');

  // Trusted-executable-path classifier (PURE, deterministic, side-effect
  // free): regular root-owned system executables pass; user-writable
  // locations, absent paths, non-absolute candidates, and symlink escapes
  // into non-trusted prefixes are refused.
  const os = require('os');
  const classifierTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-runtime-trust-'));
  try {
    // NEGATIVE fixture: a runtime installed under a user-writable prefix must
    // be refused in full — a substitutable enclosing directory is enough.
    const shadowedPrefixDirectory = path.join(classifierTemporary, 'shadow-bin');
    fs.mkdirSync(shadowedPrefixDirectory, { recursive: true });
    const shadowedExecutable = path.join(shadowedPrefixDirectory, 'shadowed-tool');
    fs.writeFileSync(shadowedExecutable, 'not-a-real-runtime\n');
    fs.chmodSync(shadowedExecutable, 0o755);
    const shadowedPrefixStat = fs.statSync(shadowedPrefixDirectory);
    ok((shadowedPrefixStat.mode & 0o200) !== 0 && shadowedPrefixStat.uid === process.getuid(),
      'the classifier negative fixture is genuinely user-writable');
    ok(lifecycleModule.trustedComposeRuntimeExecutablePath(shadowedExecutable) === null,
      'a runtime executable under a user-writable prefix is refused even with an executable file mode');
    const absentExecutable = path.join(classifierTemporary, 'absent-program');
    ok(lifecycleModule.trustedComposeRuntimeExecutablePath(absentExecutable) === null,
      'an absent candidate refuses');
    ok(lifecycleModule.trustedComposeRuntimeExecutablePath('relative/tool') === null,
      'a non-absolute candidate refuses (no ambient-name resolution)');
    if (process.platform === 'linux' && fs.existsSync('/usr/bin/sh')) {
      const trustedSystemExecutable = lifecycleModule.trustedComposeRuntimeExecutablePath('/usr/bin/sh');
      const trustedRealPath = fs.realpathSync('/usr/bin/sh');
      ok(Boolean(trustedSystemExecutable) &&
         path.isAbsolute(trustedSystemExecutable.absolutePath) &&
         trustedSystemExecutable.programRoot === path.dirname(trustedSystemExecutable.absolutePath) &&
         trustedSystemExecutable.program === path.basename(trustedRealPath),
        'a real ROOT-OWNED system executable resolves as trusted with absolute program facts');
      ok(trustedSystemExecutable && trustedSystemExecutable.absolutePath === trustedRealPath,
        'realpath identity is part of the trusted assessment');
      try {
        fs.symlinkSync(trustedRealPath, path.join(classifierTemporary, 'escape-sh'));
        ok(lifecycleModule.trustedComposeRuntimeExecutablePath(path.join(classifierTemporary, 'escape-sh')) === null,
          'a symlinked runtime whose parent tree is not a trusted prefix escapes nowhere');
      } catch (_) {
        // Symlink creation is not guaranteed on every temporary filesystem.
      }
    }
  } finally {
    fs.rmSync(classifierTemporary, { recursive: true, force: true });
  }

  // DEV-RUNTIME-A: the Compose plugin is PINNED, not just the Docker CLI.
  // Static ownership: an accepted system CLI-plugin site list, plugin
  // recovery through the supported docker info ClientInfo surface, a sterile
  // configuration directory so the user's own Docker configuration/plugins
  // never participate, and plugin validation through the SAME pure classifier
  // (absolute, regular, ROOT-OWNED, not user-writable, accepted system site).
  const devEnvironmentSource = fs.readFileSync(path.join(ROOT, 'scripts/dev-environment.js'), 'utf8');
  ok(/DOCKER_CLI_PLUGIN_SYSTEM_DIRECTORIES = Object\.freeze\(\[/.test(devDatabaseSource) &&
     devDatabaseSource.includes("'/usr/libexec/docker/cli-plugins'") &&
     devDatabaseSource.includes("'/usr/lib/docker/cli-plugins'"),
    'accepted Compose plugin sites are code-owned system directories');
  ok(devDatabaseSource.includes("const DOCKER_PLUGIN_INFO_FORMAT = '{{json .ClientInfo.Plugins}}';"),
    'the lifecycle recovers the loaded Compose plugin through the supported docker info ClientInfo surface');
  ok(/function createSterileDockerConfig\(\)/.test(devDatabaseSource) &&
     /DOCKER_CONFIG:\s*sterileDockerConfig/.test(devDatabaseSource),
    'the Docker CLI runs with an explicitly created sterile configuration directory (the personal Docker configuration never participates)');
  const runtimeSelectionSource = devDatabaseSource.slice(devDatabaseSource.indexOf('function selectComposeRuntime()'));
  ok(runtimeSelectionSource.indexOf("'compose', 'version'") > -1 &&
     runtimeSelectionSource.indexOf('DOCKER_PLUGIN_INFO_FORMAT') > -1 &&
     runtimeSelectionSource.indexOf('trustedComposeRuntimeExecutablePath(loadedComposePlugin.Path)') > -1 &&
     runtimeSelectionSource.indexOf('isAcceptedPluginSite(pluginCandidate.programRoot)') > -1,
    'the lifecycle owns plugin validation through the same pure classifier');
  ok(runtimeSelectionSource.indexOf("'compose', 'version'") < runtimeSelectionSource.indexOf('DOCKER_PLUGIN_INFO_FORMAT') &&
     runtimeSelectionSource.indexOf('DOCKER_PLUGIN_INFO_FORMAT') < runtimeSelectionSource.indexOf('trustedComposeRuntimeExecutablePath(loadedComposePlugin.Path)') &&
     runtimeSelectionSource.indexOf('trustedComposeRuntimeExecutablePath(loadedComposePlugin.Path)') < runtimeSelectionSource.indexOf('isAcceptedPluginSite(pluginCandidate.programRoot)'),
    'the lifecycle probes Compose, then recovers, then validates the plugin path in that order');
  ok(/selectedRuntime\.discardSterileDockerConfig\(\)/.test(devDatabaseSource),
    'the sterile Docker configuration lives exactly for the lifecycle invocation');
  if (process.platform === 'linux' && fs.existsSync('/usr/libexec/docker/cli-plugins/docker-compose') &&
      fs.existsSync('/usr/bin/docker')) {
    const trustedSystemDocker = lifecycleModule.trustedComposeRuntimeExecutablePath('/usr/bin/docker');
    const trustedSystemComposePlugin = lifecycleModule.trustedComposeRuntimeExecutablePath('/usr/libexec/docker/cli-plugins/docker-compose');
    ok(Boolean(trustedSystemDocker) && trustedSystemDocker.programRoot === '/usr/bin',
      'the real installed system Docker CLI is accepted on this supported machine');
    ok(Boolean(trustedSystemComposePlugin) &&
       trustedSystemComposePlugin.programRoot === '/usr/libexec/docker/cli-plugins',
      'the real installed system Compose plugin is accepted on this supported machine');
  }
  // BUNDLED-TOPOLOGY-A composition (static): the throwing guard runs the two
  // DISTINCT refusals — identity collision FIRST, then the shared-service port
  // rule — both before any contact, with their own error classes.
  ok(devEnvironmentSource.includes('const topology = assessBundledServiceTopologyGuard(env);') &&
     devEnvironmentSource.indexOf('const topology = assessBundledServiceTopologyGuard(env);') >
       devEnvironmentSource.indexOf('const assessment = assessDevelopmentTargetCollision(env);'),
    'the throwing guard composes COLLISION-A before BUNDLED-TOPOLOGY-A');
  ok(/class DevelopmentServiceTopologyError extends Error[\s\S]{0,300}DEVELOPMENT_SERVICE_TOPOLOGY_REFUSED/.test(devEnvironmentSource),
    'the bundled-topology refusal carries its own distinct error class and code');
  // The only directly callable store factory (dev-environment) stays GUARDED:
  // constructing it for real carries no disposable authority, and env cannot
  // redirect it. Its construction happens on the REAL guarded seam (offline;
  // construction never opens a connection).
  const guardedProbe = devEnvironmentModule.createGuardedDevelopmentStore({
    TICKET_SYSTEM_POSTGRES_PORT: '39989',
    DATABASE_URL: 'postgresql://redirector:test-only-password@ops.example:6544/redirected'
  });
  ok(guardedProbe.disposableMigrations === false,
    'the only directly callable development store factory is GUARDED (env alone can obtain NO disposable authority)');
  const guardedProbeClosed = guardedProbe.close();

  // Argument refusal is provable BEFORE any launch/verification or database
  // contact: any argument (authority-affecting or not) rejects immediately.
  // NOTE: an argument-less call in THIS suite would drive the REAL lifecycle
  // (real compose, real disposable migration) — it belongs only to the REAL
  // developer smoke, never to these deterministic assertions.
  const attackerRefusals = [];
  const refusedArgumentCases = [];
  refusedArgumentCases.push(
    lifecycleModule.prepareAndMigrateDisposableDevelopmentDatabase({
      spawn: () => ({ status: 0 }),
      runtime: { command: 'fake', prefix: [], label: 'Fake Compose' },
      composeFile: '/attacker/fake-compose.yml',
      verifyDatabase: async () => {},
      clientFactory: () => null,
      devTarget: { host: '10.9.9.9', port: 1234, database: 'attacker_db', schema: 'attacker_schema' },
      env: { TICKET_SYSTEM_POSTGRES_PORT: '55432' }
    }).then(() => { throw new Error('UNEXPECTED-RESOLVE prepareAndMigrate…'); },
      error => attackerRefusals.push({ operation: 'prepareAndMigrate…', error }))
  );
  refusedArgumentCases.push(
    lifecycleModule.resetDisposableDevelopmentDatabase('stray-position-argument').then(
      () => { throw new Error('UNEXPECTED-RESOLVE reset…'); },
      error => attackerRefusals.push({ operation: 'reset…', error })
    )
  );
  Promise.all(refusedArgumentCases).then(() => {
    ok(attackerRefusals.length === 2,
      'the full attacker kit (proof mechanics plus identity) AND a positional string both refuse');
    for (const refusal of attackerRefusals) {
      ok(/accepts no arguments/.test(String(refusal && refusal.error && refusal.error.message)),
        `${refusal.operation} argument refusal names the zero-argument authority property: ${refusal && refusal.error && refusal.error.message}`);
    }
  });
  const migrationAuthoritySource = fs.readFileSync(path.join(ROOT, 'persistence/postgres/migration-authority.js'), 'utf8');
  ok(migrationAuthoritySource.includes('no env-var skip, no target-derived skip'),
    'migration authority doctrine still forbids environment/target-derived disposability');
  ok(migrationAuthoritySource.includes("RECORD_RELATIVE_PATH = 'config/migration-execution-authorization.json'"),
    'the canonical tracked record home is unchanged');

  // The PASS line ONLY after every promise-derived ok() above resolves.
  Promise.resolve(guardedProbeClosed).then(() => {
    console.log(`\nPASS: migration execution-authority contract — ${assertions} assertions (pure; no database contact)`);
  }).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
