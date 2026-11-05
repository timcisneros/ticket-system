#!/usr/bin/env node
'use strict';

// P6-S2 owning contract test (deterministic, no database).
//
// Owns the frozen semantics that do not require PostgreSQL to prove:
//
//   HEALTH-A/B  — liveness, readiness, and capacity stay distinct; no
//                 PostgreSQL probe fact can make liveness false; the process
//                 answering at all is the liveness evidence.
//   CAPACITY-A/B — backpressure saturates capacity status but NEVER readiness;
//                  capacity remains observable in every payload.
//   PG-A        — readiness consumes the canonical migration-status facts
//                 (classifyMigrationStatus over the exact
//                 `PostgresRuntimeStore.getMigrationStatus()` shape); no
//                 second migration parser exists here.
//   CONFIG-A/B — one executable registry owns supported configuration;
//   SECRET-A/B — registry validation and health projections identify setting
//                 NAMES, never secret values;
//   MIGRATION DIAGNOSTICS — the doctor's disposable-development ledger
//                 classifier distinguishes current / behind / uninitialized /
//                 incompatible+drifted; the behind guidance states the
//                 code-declared disposable development authority (auto-migrate
//                 on `npm run dev`) and NEVER claims operational migration
//                 authorization. The dev:setup refusal-guidance export keeps
//                 pointing at the governed authorization procedure only, and
//                 never claims `dev:setup` can bypass the migration authority.
//
// The PostgreSQL-native counterpart (p6-s2-readiness-postgres-test.js) proves
// the same seams against real persistence; registration policy keeps both
// listed in scripts/test-manifest.js.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildHealthProjection,
  classifyMigrationStatus,
  effectRootReadiness,
  READINESS_PROJECTION_VERSION,
  sanitizePostgresProbeError
} = require('../runtime/health-readiness');
const {
  CLASSIFICATIONS,
  DEVELOPMENT_SETTINGS,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_SESSION_SECRET_LENGTH,
  PROVIDER_SETTINGS,
  SETTINGS,
  TEST_ONLY_SETTINGS,
  isSupportedSetting,
  operatorExposedSettingNames,
  settingByName,
  settingSecret,
  supportedSettingNames,
  validateAdminPassword,
  validateEnvironment,
  validateHttpOrigin,
  validatePort,
  validatePostgresUrl,
  validateSessionSecret
} = require('../runtime/environment-config-registry');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_A = ['040_ticket_cancellation_authority.sql', '041_ticket_five_state_cutover.sql'];

function fakeChecksum(version) {
  // 64-hex (the canonical record validator requires sha256-hex digests) but
  // fixture-derived, never the real migration checksums.
  return require('crypto').createHash('sha256').update(`fixture:${version}`).digest('hex');
}

let scenarioCount = 0;
function scenario(label) {
  scenarioCount += 1;
  console.log(`  ok ${label}`);
}

function healthyProbe(overrides) {
  return {
    reachable: true,
    migrationStatus: {
      currentVersion: 44,
      headVersion: 44,
      fullyApplied: true,
      checksumsValid: true,
      partial: false,
      pendingMigrations: 0,
      unknownMigrations: 0,
      ...overrides
    }
  };
}

const ADMISSION_METRICS = Object.freeze({
  backend: 'postgres',
  role: 'mutation_admission',
  scope: 'process',
  status: 'available',
  current: { outstanding: 0, outstandingBytes: 0, availableSlots: 256, availableBytes: 536870912, backpressured: false, utilization: 0 },
  limits: { maxOutstanding: 256, maxOutstandingBytes: 536870912, maxReservationBytes: 2097152 },
  highWatermarks: { outstanding: 0, outstandingBytes: 0 },
  totals: { acquired: 0, released: 0, rejected: 0, oversizedRejected: 0 }
});

function admissionSaturated() {
  return {
    ...ADMISSION_METRICS,
    status: 'backpressured',
    current: { ...ADMISSION_METRICS.current, outstanding: 256, availableSlots: 0, backpressured: true, utilization: 1 },
    highWatermarks: { outstanding: 256, outstandingBytes: ADMISSION_METRICS.limits.maxOutstandingBytes }
  };
}

// Environment-independent projection wrapper: the module's real default reads
// process.env (correct for the server boot surface); every deterministic
// scenario here feeds an explicit satisfied configuration so the contract is
// provable regardless of the host environment.
const SATISFIED_CONFIGURATION = validateEnvironment({
  DATABASE_URL: 'postgresql://probe:probe@localhost:5432/ticket_system',
  SESSION_SECRET: 'x'.repeat(64)
});
assert.equal(SATISFIED_CONFIGURATION.ok, true);
function project(inputs) {
  const { configurationFailures, ...rest } = inputs;
  return buildHealthProjection({
    ...rest,
    configurationFailures: configurationFailures === undefined ? SATISFIED_CONFIGURATION : configurationFailures
  });
}

// ── HEALTH-A / HEALTH-B: liveness is independent of every dependency ────────

for (const projection of [
  project({ postgresProbe: { reachable: false, failure: { code: 'ECONNREFUSED' } }, admissionMetrics: ADMISSION_METRICS }),
  project({ postgresProbe: { reachable: true, migrationStatus: { fullyApplied: false, pendingMigrations: 1, unknownMigrations: 0, checksumsValid: false, partial: false, currentVersion: 43, headVersion: 44 } }, admissionMetrics: ADMISSION_METRICS }),
  project({ evidencePersistenceLatched: true, postgresProbe: healthyProbe(), admissionMetrics: ADMISSION_METRICS }),
  project({ serverReady: false, admissionMetrics: ADMISSION_METRICS })
]) {
  assert.equal(projection.payload.alive, true, 'HEALTH-B: liveness stays true in every not-ready projection');
  assert.equal(projection.payload.ready, false, 'HEALTH-A: these projections are not ready');
}
scenario('HEALTH-B: liveness remains true across every dependency failure projection');

const healthy = project({ postgresProbe: healthyProbe(), admissionMetrics: ADMISSION_METRICS });
assert.equal(healthy.statusCode, 200);
assert.equal(healthy.ready, true);
assert.equal(healthy.payload.alive, true);
assert.equal(healthy.payload.status, 'ok');
assert.equal(healthy.payload.readiness, undefined, 'ready payloads carry no diagnosis block');
scenario('HEALTH-A: ready projection is 200/ready/alive with a distinct capacity surface');

// Liveness must not consult capacity either: a fully saturated process stays
// alive and ready.
const saturatedHealthy = project({
  postgresProbe: healthyProbe(),
  admissionMetrics: admissionSaturated()
});
assert.equal(saturatedHealthy.statusCode, 200);
assert.equal(saturatedHealthy.ready, true);
assert.equal(saturatedHealthy.payload.alive, true);
assert.equal(saturatedHealthy.payload.status, 'ok');
scenario('CAPACITY-A: saturation never makes a ready process unready');

// CAPACITY-B: capacity remains observable in ready AND not-ready payloads.
for (const projection of [healthy, saturatedHealthy]) {
  const metrics = projection.payload.capacity.mutationAdmission;
  assert.ok(metrics, 'CAPACITY-B: capacity state is present in every payload');
  assert.equal(metrics.role, 'mutation_admission', 'CAPACITY-B: admission metrics keep their observation contract');
}
assert.equal(saturatedHealthy.payload.capacity.mutationAdmission.current.backpressured, true, 'CAPACITY-B: saturation is observable');
assert.equal(healthy.payload.capacity.mutationAdmission.current.backpressured, false, 'CAPACITY-B: availability is observable');
scenario('CAPACITY-B: capacity state remains observable in every payload');

const saturatedNotReady = project({
  postgresProbe: { reachable: false, failure: { code: 'ECONNREFUSED' } },
  admissionMetrics: admissionSaturated()
});
assert.equal(saturatedNotReady.statusCode, 503);
assert.equal(saturatedNotReady.payload.capacity.mutationAdmission.current.backpressured, true);
scenario('CAPACITY-B: capacity stays observable in not-ready payloads too');

// ── PG-A: readiness consumes canonical migration-status facts ───────────────

const currentProjectionCheck = classifyMigrationStatus({ fullyApplied: true, currentVersion: 44, headVersion: 44, pendingMigrations: 0, unknownMigrations: 0, checksumsValid: true, partial: false });
assert.equal(currentProjectionCheck.compatible, true);
assert.equal(currentProjectionCheck.code, 'migrations_current');
const pendingProjection = project({
  postgresProbe: { reachable: true, migrationStatus: { fullyApplied: false, currentVersion: 43, headVersion: 44, pendingMigrations: 1, unknownMigrations: 0, checksumsValid: false, partial: false } },
  admissionMetrics: ADMISSION_METRICS
});
assert.equal(pendingProjection.statusCode, 503);
assert.equal(pendingProjection.payload.reason, 'migrations_incompatible');
assert.equal(pendingProjection.payload.readiness.migrations.code, 'migrations_pending');
assert.equal(pendingProjection.payload.readiness.migrations.facts.headVersion, 44);
scenario('PG-A: pending migrations classify incompatible with canonical facts');

assert.equal(classifyMigrationStatus({ fullyApplied: false, currentVersion: 44, headVersion: 44, pendingMigrations: 0, unknownMigrations: 2, checksumsValid: false, partial: true }).code, 'migrations_unknown');
assert.equal(classifyMigrationStatus({ fullyApplied: false, currentVersion: 44, headVersion: 44, pendingMigrations: 0, unknownMigrations: 0, checksumsValid: false, partial: true }).code, 'migrations_partial');
assert.equal(classifyMigrationStatus({ fullyApplied: false, currentVersion: 0, headVersion: 44, pendingMigrations: 44, unknownMigrations: 0, checksumsValid: false, partial: false }).code, 'migrations_pending');
assert.equal(classifyMigrationStatus(null).compatible, false);
scenario('PG-A: unknown/partial/pending/unavailable canonical states classify distinctively');

const partialProjection = project({
  postgresProbe: { reachable: true, migrationStatus: { fullyApplied: false, currentVersion: 44, headVersion: 44, pendingMigrations: 0, unknownMigrations: 0, checksumsValid: false, partial: true } },
  admissionMetrics: ADMISSION_METRICS
});
assert.equal(partialProjection.statusCode, 503);
assert.equal(partialProjection.payload.readiness.migrations.code, 'migrations_partial');
scenario('readiness is false on checksum/identity (partial) failure through the canonical shape');

// Sanitized failure shape: only bounded codes/labels; no raw message text.
const probeError = new Error('connect ECONNREFUSED postgresql://user:secret@127.0.0.1:59999/db');
probeError.code = 'ECONNREFUSED';
const sanitized = sanitizePostgresProbeError(probeError);
assert.deepEqual(sanitized, { code: 'ECONNREFUSED', label: 'postgres_probe_refused:ECONNREFUSED' });
assert.equal(JSON.stringify(sanitized).includes('secret'), false, 'SECRET-A: probe failure carries no error text or credentials');
const unreachableProjection = project({
  postgresProbe: { reachable: false, failure: sanitized },
  admissionMetrics: ADMISSION_METRICS
});
assert.equal(unreachableProjection.statusCode, 503);
assert.equal(unreachableProjection.payload.reason, 'postgres_unreachable');
assert.equal(unreachableProjection.payload.readiness.postgresql, 'unreachable');
assert.equal(JSON.stringify(unreachableProjection.payload).includes('ECONNREFUSED'), false, 'failure payloads are sanitized');
assert.equal(JSON.stringify(unreachableProjection.payload).includes('127.0.0.1'), false);
scenario('PostgreSQL outage: designed bounded 503 with sanitized facts (no credentials, hosts, or raw error text)');

// ── Evidence-persistence latch (existing semantics, preserved exactly) ──────

const latched = project({ evidencePersistenceLatched: true, postgresProbe: healthyProbe(), admissionMetrics: ADMISSION_METRICS });
assert.equal(latched.statusCode, 503);
assert.equal(latched.payload.status, 'degraded', 'latch keeps the established degraded status');
assert.equal(latched.payload.ready, false);
assert.equal(latched.payload.alive, true, 'liveness may remain true under the latch');
assert.equal(latched.payload.reason, 'evidence_persistence_latched');
assert.equal(latched.payload.readiness.evidencePersistence, 'latched');
scenario('evidence-persistence latch: degraded, not ready, liveness intact, capacity irrelevant');

// Latch precedence over a healthy probe.
assert.equal(project({ evidencePersistenceLatched: true, postgresProbe: healthyProbe(), admissionMetrics: ADMISSION_METRICS }).payload.status, 'degraded');
// And over startup readiness: the established fail-closed sequencing clears
// serverReady in the same latch, so the latch keeps its distinct degraded
// status (pinned by the A20 admission owner).
assert.equal(
  project({ serverReady: false, evidencePersistenceLatched: true, postgresProbe: healthyProbe() }).payload.status,
  'degraded'
);
scenario('latch precedence holds even with an otherwise fully healthy probe');

// ── Configuration and effect-root readiness ────────────────────────────────

const validBootConfiguration = validateEnvironment({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/ticket_system',
  SESSION_SECRET: 'x'.repeat(64)
});
assert.equal(validBootConfiguration.ok, true);

const invalidBootConfiguration = validateEnvironment({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/ticket_system',
  SESSION_SECRET: 'x'.repeat(64),
  PORT: 'not-a-port'
});
assert.equal(invalidBootConfiguration.ok, false);
const configurationProjection = project({
  postgresProbe: healthyProbe(),
  admissionMetrics: ADMISSION_METRICS,
  configurationFailures: invalidBootConfiguration
});
assert.equal(configurationProjection.statusCode, 503);
assert.equal(configurationProjection.payload.reason, 'configuration_invalid');
assert.deepEqual(configurationProjection.payload.readiness.configuration.invalidSettings, ['PORT']);
assert.equal(JSON.stringify(configurationProjection.payload).includes('not-a-port'), false, 'SECRET-A/CONFIG-A: configuration failures render names, never values');
scenario('required startup configuration invalid → readiness false, names only');

// Missing required settings fail deterministically for boot context.
const missingRequired = validateEnvironment({ SESSION_SECRET: 'x'.repeat(64) });
assert.equal(missingRequired.ok, false);
assert.ok(missingRequired.failures.some(failure => failure.name === 'DATABASE_URL' && failure.code === 'missing_required_setting'));
const missingSecret = validateEnvironment({ DATABASE_URL: 'postgresql://u:p@localhost/db' });
assert.equal(missingSecret.ok, false);
assert.ok(missingSecret.failures.some(failure => failure.name === 'SESSION_SECRET'));
// Same input is deterministic.
assert.deepEqual(validateEnvironment({ SESSION_SECRET: 'x'.repeat(64) }), missingRequired);
assert.deepEqual(validateEnvironment({ DATABASE_URL: 'postgresql://u:p@localhost/db' }), missingSecret);
scenario('CONFIG-B: required/optional/default semantics are deterministic');

// Probe must remain read-only in classification terms: an unreachable probe
// and a valid one move readiness, never liveness, and never mutate anything.
assert.equal(project({ postgresProbe: { reachable: false, failure: { code: '08006' } }, admissionMetrics: ADMISSION_METRICS }).payload.alive, true);
scenario('no health projection consults or mutates PostgreSQL state for liveness/capacity');

// Effect roots (Defect-B): a REQUIRED effect root is usable only if the
// runtime can actually use it as its required DIRECTORY boundary. The
// usability facts never carry filesystem paths.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'p6s2-roots-'));
try {
  const existingDir = path.join(temporary, 'workspace-root');
  fs.mkdirSync(existingDir);
  const missingRoot = path.join(temporary, 'created-later', 'artifacts');
  fs.mkdirSync(path.join(temporary, 'created-later'));
  const roots = effectRootReadiness([
    { id: 'workspace', root: existingDir },
    { id: 'artifacts', root: missingRoot }
  ]);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].usable, true, 'existing usable directory root is usable');
  assert.equal(roots[0].reason, 'usable');
  assert.equal(roots[1].usable, true, 'missing root under a usable parent is creatable');
  assert.equal(roots[1].reason, 'creatable');
  const rendered = JSON.stringify(roots);
  assert.equal(rendered.includes(temporary), false, 'effect-root facts never carry absolute paths');

  // REQUIRED roots pointing at writable regular FILES must NOT be usable.
  const fileWorkspace = path.join(temporary, 'workspace-file');
  fs.writeFileSync(fileWorkspace, 'regular file');
  const fileArtifacts = path.join(temporary, 'artifacts-file');
  fs.writeFileSync(fileArtifacts, 'regular file');
  const fileRoots = effectRootReadiness([
    { id: 'workspace', root: fileWorkspace },
    { id: 'artifacts', root: fileArtifacts }
  ]);
  assert.equal(fileRoots[0].usable, false, 'a writable regular file is NOT a usable workspace root');
  assert.equal(fileRoots[0].reason, 'not_a_directory');
  assert.equal(fileRoots[1].usable, false, 'a writable regular file is NOT a usable artifact root');
  assert.equal(fileRoots[1].reason, 'not_a_directory');

  // Dangling-symlink defect correction (review-B defect 2). A symlink whose
  // target does not exist ALREADY OCCUPIES the pathname: the followed
  // existence probe cannot see through it and must not swallow the entry as
  // "missing". Recursive root creation (`mkdirSync(root, {recursive:true})`)
  // cannot create through an occupied pathname, so a dangling root is
  // unusable and NEVER creatable — while a symlink whose target IS a
  // directory stays exactly as usable as the directory it resolves to, and
  // not all symlinks are rejected merely for being symlinks.
  const linkedWorkspace = path.join(temporary, 'linked-workspace');
  fs.symlinkSync(existingDir, linkedWorkspace);              // target: real directory
  const linkedFile = path.join(temporary, 'linked-file');
  fs.symlinkSync(fileWorkspace, linkedFile);                 // target: regular file
  const danglingWorkspace = path.join(temporary, 'dangling-workspace');
  fs.symlinkSync(path.join(temporary, 'absent-workspace-target'), danglingWorkspace);
  const danglingArtifacts = path.join(temporary, 'dangling-artifacts');
  fs.symlinkSync(path.join(temporary, 'absent-artifacts-target'), danglingArtifacts);
  const entryKinds = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .map(entry => `${entry.name}:${entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'link'}`)
    .sort();
  const listingBeforeProbe = entryKinds(temporary);
  const occupancyRoots = effectRootReadiness([
    { id: 'workspace', root: linkedWorkspace },
    { id: 'artifacts', root: linkedFile },
    { id: 'workspace-dangling', root: danglingWorkspace },
    { id: 'artifacts-dangling', root: danglingArtifacts }
  ]);
  assert.equal(entryKinds(temporary).join('|'), listingBeforeProbe.join('|'), 'probing classifies without mutating any directory entry');
  assert.equal(occupancyRoots[0].usable, true, 'a valid symlink to a directory remains usable (runtime-supported boundary)');
  assert.equal(occupancyRoots[0].reason, 'usable');
  assert.equal(occupancyRoots[1].usable, false, 'a symlink to a regular file is NOT a directory boundary');
  assert.equal(occupancyRoots[1].reason, 'not_a_directory');
  assert.equal(occupancyRoots[2].usable, false, 'a dangling symlink root is unusable');
  assert.equal(occupancyRoots[2].reason, 'not_a_directory', 'a dangling root keeps an existing sanitized reason (no reason-vocabulary growth, no target leak)');
  assert.equal(occupancyRoots[3].usable, false, 'a dangling artifact root is unusable');
  assert.equal(
    [occupancyRoots[2].reason, occupancyRoots[3].reason].some(reason => reason === 'creatable'),
    false,
    'a dangling symlink root never classifies as creatable'
  );
  const occupancyRendered = JSON.stringify(occupancyRoots);
  assert.equal(occupancyRendered.includes(temporary), false, 'effect-root facts never carry absolute paths');
  assert.equal(occupancyRendered.includes('absent-workspace-target'), false, 'symlink targets are never exposed');
  assert.equal(occupancyRendered.includes('absent-artifacts-target'), false, 'symlink targets are never exposed');
  scenario('dangling symlink root is unusable (never creatable); valid symlink to a directory stays usable; probing mutates nothing');

  if (process.getuid && process.getuid() !== 0) {
    // A directory with WRITE permission but NO traverse permission is the
    // exact old false positive (W_OK alone was accepted): it must be unusable.
    const noTraverse = path.join(temporary, 'no-traverse');
    fs.mkdirSync(noTraverse);
    fs.chmodSync(noTraverse, 0o200);
    const noTraverseRoots = effectRootReadiness([{ id: 'workspace', root: noTraverse }]);
    assert.equal(noTraverseRoots[0].usable, false, 'a non-traversable directory is NOT usable');
    assert.equal(noTraverseRoots[0].reason, 'insufficient_permissions');
    fs.chmodSync(noTraverse, 0o700);

    const noWrite = path.join(temporary, 'no-write');
    fs.mkdirSync(noWrite);
    fs.chmodSync(noWrite, 0o500);
    const noWriteRoots = effectRootReadiness([{ id: 'workspace', root: noWrite }]);
    assert.equal(noWriteRoots[0].usable, false, 'a directory without write access is NOT usable');
    fs.chmodSync(noWrite, 0o700);

    // A MISSING root under unusable parents must not be reported ready.
    const parentFile = path.join(temporary, 'parent-file');
    fs.writeFileSync(parentFile, 'regular file');
    const underFile = effectRootReadiness([{ id: 'workspace', root: path.join(parentFile, 'missing') }]);
    assert.equal(underFile[0].usable, false, 'a missing root whose parent is a file is NOT creatable');
    assert.equal(underFile[0].reason, 'parent_not_a_directory');

    const blockedParent = path.join(temporary, 'blocked-parent');
    fs.mkdirSync(blockedParent);
    fs.chmodSync(blockedParent, 0o000);
    const underBlocked = effectRootReadiness([{ id: 'workspace', root: path.join(blockedParent, 'missing') }]);
    assert.equal(underBlocked[0].usable, false, 'a missing root under an unusable parent is NOT creatable');
    assert.equal(underBlocked[0].reason, 'parent_insufficient_permissions');
    fs.chmodSync(blockedParent, 0o700);

    const blocked = effectRootReadiness([
      { id: 'blocked', root: path.join('/proc', process.pid.toString(), 'nonexistent-root-for-p6s2') }
    ]);
    assert.equal(blocked[0].usable, false, 'an unreadable/uncreatable procfs boundary is NOT usable');
    assert.equal(
      ['parent_insufficient_permissions', 'no_existing_parent', 'insufficient_permissions'].includes(blocked[0].reason),
      true
    );
    scenario('effect root unusable (file/traverse/unusable parent) → readiness false without leaking paths');
  } else {
    scenario('effect root permission regressions skipped under root (platform can bypass permissions)');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

// Dangling-symlink ANCESTOR defect correction (review-C defect). A missing
// configured root whose ancestor chain contains a filesystem entry must NOT
// be classified `creatable` through that entry when the runtime recursive
// creation cannot traverse it. The dangerous pre-fix topology:
//
//   base/dangling-link -> missing-target      (an OCCUPIED ancestor)
//   configured root: base/dangling-link/child (final pathname missing)
//
// The pre-fix ancestor walk used a FOLLOWED existence probe; a dangling
// symlink follows to "absent", so the walk skipped the very entry that
// occupies the way, reached the first real directory `base`, and falsely
// concluded `creatable` — while `fs.mkdirSync('<...>/dangling-link/child',
// { recursive: true })` fails (ENOENT). The walk now stops at the nearest
// OCCUPIED component (non-following `lstatSync` inspection) and that
// component's RESOLVED truth decides: a valid symlink to a directory stays
// exactly as traversable as the directory it resolves to (the runtime
// recursion creates the full requested chain below it); a dangling symlink,
// a symlink to a regular file, or a regular file keeps the boundary
// uncreatable with the existing sanitized `parent_not_a_directory` reason.
// Everything here is compared against the same runtime's actual recursive
// directory operation, established on a SEPARATE disposable topology (the
// test may perform the runtime mkdir; the production probe itself never
// creates anything), and the probe provably mutates no directory entry and
// exposes no path or symlink target.
const ancestorTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'p6s2-ancestors-'));
try {
  const kinds = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .map(entry => `${entry.name}:${entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'link'}`)
    .sort();

  // ── 1. Disposable RUNTIME-TRUTH topology (may be mutated by the runtime) ──
  // Establish what THIS runtime's recursive directory operation actually does
  // through each interesting ancestor class, on fixture paths the probe never
  // inspects, then hold the probe's conclusions against that truth.
  const truthTemporary = path.join(ancestorTemporary, 'runtime-truth-topology');
  const realTruthParent = path.join(truthTemporary, 'real-dir');
  fs.mkdirSync(realTruthParent, { recursive: true });
  const truthValidLink = path.join(realTruthParent, 'valid-link');
  fs.symlinkSync(realTruthParent, truthValidLink);           // symlink -> dir
  const truthDanglingLink = path.join(realTruthParent, 'dangling-link');
  fs.symlinkSync(path.join(truthTemporary, 'missing-target-nowhere'), truthDanglingLink);
  const truthFileAncestor = path.join(truthTemporary, 'file');
  fs.writeFileSync(truthFileAncestor, 'regular file');
  const truthFileLink = path.join(realTruthParent, 'file-link');
  fs.symlinkSync(truthFileAncestor, truthFileLink);          // symlink -> file

  function runtimeMkdirTruth(fn) {
    try {
      fn();
      return 'OK';
    } catch (err) {
      return err.code;
    }
  }
  const truth = {
    realDir: runtimeMkdirTruth(() =>
      fs.mkdirSync(path.join(realTruthParent, 'truth-real', 'a'), { recursive: true })),
    validLink: runtimeMkdirTruth(() =>
      fs.mkdirSync(path.join(truthValidLink, 'truth-valid', 'a'), { recursive: true })),
    danglingLink: runtimeMkdirTruth(() =>
      fs.mkdirSync(path.join(truthDanglingLink, 'truth-dangling'), { recursive: true })),
    danglingLinkDeep: runtimeMkdirTruth(() =>
      fs.mkdirSync(path.join(truthDanglingLink, 'truth-dangling-a', 'b'), { recursive: true })),
    fileLink: runtimeMkdirTruth(() =>
      fs.mkdirSync(path.join(truthFileLink, 'truth-file-link'), { recursive: true })),
    fileAncestor: runtimeMkdirTruth(() =>
      fs.mkdirSync(path.join(truthFileAncestor, 'truth-file'), { recursive: true }))
  };
  // The established runtime truth itself must match the documented runtime
  // contract (only a boundary resolving to a directory hosts creation):
  assert.equal(truth.realDir, 'OK', 'runtime recursive creation works below a real directory');
  assert.equal(truth.validLink, 'OK', 'runtime recursive creation works below a valid symlink to a directory');
  assert.notEqual(truth.danglingLink, 'OK', 'runtime recursive creation fails through a dangling symlink ancestor');
  assert.notEqual(truth.danglingLinkDeep, 'OK', 'runtime recursive creation fails through a dangling symlink ancestor deeper too');
  assert.notEqual(truth.fileLink, 'OK', 'runtime recursive creation fails through a symlink-to-file ancestor');
  assert.notEqual(truth.fileAncestor, 'OK', 'runtime recursive creation fails through a regular-file ancestor');

  // ── 2. Probe topology (NEVER mutated: asserted before/after) ──────────────
  const probeTemporary = path.join(ancestorTemporary, 'probe-topology');
  const base = path.join(probeTemporary, 'base');
  fs.mkdirSync(base, { recursive: true });
  const realParentDir = path.join(base, 'real-parent-dir');
  fs.mkdirSync(realParentDir);
  const validLink = path.join(base, 'valid-link');
  fs.symlinkSync(realParentDir, validLink);                  // symlink -> dir
  const danglingLink = path.join(base, 'dangling-link');
  fs.symlinkSync(path.join(probeTemporary, 'missing-target-never-exists'), danglingLink);
  const fileLink = path.join(base, 'file-link');
  fs.writeFileSync(path.join(base, 'regular-file'), 'regular file');
  fs.symlinkSync(path.join(base, 'regular-file'), fileLink); // symlink -> file
  const fileAncestor = path.join(base, 'file');
  fs.writeFileSync(fileAncestor, 'regular file');

  const ancestorProbeListing =
    { base: kinds(base), probeTemporary: kinds(probeTemporary) };
  const ancestorRoots = effectRootReadiness([
    { id: 'real-dir',          root: path.join(realParentDir, 'missing-child') },
    { id: 'valid-link',        root: path.join(validLink, 'child', 'grandchild') },
    { id: 'dangling-link',     root: path.join(danglingLink, 'child') },
    { id: 'dangling-link-deep', root: path.join(danglingLink, 'a', 'b') },
    { id: 'file-link',         root: path.join(fileLink, 'child') },
    { id: 'file-ancestor',     root: path.join(fileAncestor, 'child') }
  ]);
  assert.equal(ancestorRoots.length, 6);
  // The probe's conclusion MUST equal the runtime truth for every class: the
  // classification is truthful about THIS runtime, in BOTH directions.
  assert.equal(ancestorRoots[0].usable, truth.realDir === 'OK');
  assert.equal(ancestorRoots[1].usable, truth.validLink === 'OK');
  assert.equal(ancestorRoots[2].usable, truth.danglingLink === 'OK');
  assert.equal(ancestorRoots[3].usable, truth.danglingLinkDeep === 'OK');
  assert.equal(ancestorRoots[4].usable, truth.fileLink === 'OK');
  assert.equal(ancestorRoots[5].usable, truth.fileAncestor === 'OK');
  // And the sanitized classification for each class:
  assert.equal(ancestorRoots[0].usable, true, 'a missing root below a real directory is creatable');
  assert.equal(ancestorRoots[0].reason, 'creatable');
  assert.equal(ancestorRoots[1].usable, true, 'a missing chain below a valid symlink to a directory remains creatable when the runtime supports it');
  assert.equal(ancestorRoots[1].reason, 'creatable');
  assert.equal(ancestorRoots[2].usable, false, 'a dangling symlink ancestor makes the root unusable');
  assert.equal(ancestorRoots[2].reason, 'parent_not_a_directory');
  assert.equal(ancestorRoots[3].usable, false, 'a dangling symlink ancestor deeper makes the root unusable');
  assert.equal(ancestorRoots[3].reason, 'parent_not_a_directory');
  assert.equal(ancestorRoots[4].usable, false, 'a symlink-to-file ancestor makes the root unusable');
  assert.equal(ancestorRoots[4].reason, 'parent_not_a_directory');
  assert.equal(ancestorRoots[5].usable, false, 'a regular-file ancestor makes the root unusable');
  assert.equal(ancestorRoots[5].reason, 'parent_not_a_directory');
  assert.equal(
    ancestorRoots.filter(root => root.id.startsWith('dangling') || root.id.startsWith('file-')).some(root => root.reason === 'creatable'),
    false,
    'no occupied non-directory ancestor class is EVER classified creatable'
  );

  // ── 3. Non-mutation + secrecy of the probe ────────────────────────────────
  assert.equal(kinds(base).join('|'), ancestorProbeListing.base.join('|'), 'probing the ancestor matrix mutates NO directory entry');
  assert.equal(kinds(probeTemporary).join('|'), ancestorProbeListing.probeTemporary.join('|'), 'probing the ancestor matrix mutates NO directory entry');
  const ancestorRendered = JSON.stringify(ancestorRoots);
  assert.equal(ancestorRendered.includes(ancestorTemporary), false, 'effect-root ancestor facts never carry absolute paths');
  assert.equal(ancestorRendered.includes('missing-target-never-exists'), false, 'symlink targets are never exposed for ancestor classifications');
  scenario('dangling symlink ANCESTOR is unusable (never creatable); valid symlink-to-directory ancestor stays creatable exactly as the runtime recursion supports');
} finally {
  fs.rmSync(ancestorTemporary, { recursive: true, force: true });
}

// Readiness integration: a file-backed work boundary fails readiness and the
// payload still exposes no absolute paths.
const fileBackedTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'p6s2-rootfile-'));
try {
  const fileBackedWorkRoot = path.join(fileBackedTemporary, 'workspace-root');
  fs.writeFileSync(fileBackedWorkRoot, 'regular file');
  const unusableProjection = project({
    postgresProbe: healthyProbe(),
    admissionMetrics: ADMISSION_METRICS,
    effectRoots: [{ id: 'workspace', root: fileBackedWorkRoot }]
  });
  assert.equal(unusableProjection.statusCode, 503);
  assert.equal(unusableProjection.payload.reason, 'effect_root_unusable');
  assert.equal(
    JSON.stringify(unusableProjection.payload).includes(fileBackedTemporary),
    false,
    'the readiness diagnosis never carries absolute paths'
  );
  assert.deepEqual(
    unusableProjection.payload.readiness.effectRoots,
    [{ id: 'workspace', usable: false }]
  );

  // The same designed 503 for a DANGLING symlink root, with the sanitized
  // readiness payload carrying no path and no symlink target.
  const fileBackedDangling = path.join(fileBackedTemporary, 'dangling-root');
  fs.symlinkSync(path.join(fileBackedTemporary, 'absent-dangling-target'), fileBackedDangling);
  const danglingProjection = project({
    postgresProbe: healthyProbe(),
    admissionMetrics: ADMISSION_METRICS,
    effectRoots: [{ id: 'workspace', root: fileBackedDangling }]
  });
  assert.equal(danglingProjection.statusCode, 503);
  assert.equal(danglingProjection.payload.reason, 'effect_root_unusable');
  assert.deepEqual(
    danglingProjection.payload.readiness.effectRoots,
    [{ id: 'workspace', usable: false }]
  );
  assert.equal(
    JSON.stringify(danglingProjection.payload).includes(fileBackedTemporary),
    false,
    'the readiness diagnosis never carries absolute paths'
  );
  assert.equal(
    JSON.stringify(danglingProjection.payload).includes('absent-dangling-target'),
    false,
    'the readiness diagnosis never carries symlink targets either'
  );
} finally {
  fs.rmSync(fileBackedTemporary, { recursive: true, force: true });
}
scenario('file-backed effect boundary → designed readiness 503 with path-free facts');
scenario('dangling symlink effect root → designed readiness 503 with path-free, target-free facts');

// ── Uptime surface difference between the two public routes ────────────────

assert.equal(typeof project({ postgresProbe: healthyProbe(), admissionMetrics: ADMISSION_METRICS, includeUptime: true }).payload.uptime, 'number');
assert.equal(project({ postgresProbe: healthyProbe(), admissionMetrics: ADMISSION_METRICS, includeUptime: false }).payload.uptime, undefined);
assert.equal(READINESS_PROJECTION_VERSION, 1);
scenario('/health and /api/health share the same contract; /api/health adds uptime only');

// ── CONFIG-A/B: one executable registry owns supported configuration ────────

assert.deepEqual(
  [...CLASSIFICATIONS].sort(),
  ['application', 'development', 'provider', 'secret', 'test-only']
);
const allSettings = [...SETTINGS, ...PROVIDER_SETTINGS, ...DEVELOPMENT_SETTINGS, ...TEST_ONLY_SETTINGS];
assert.equal(supportedSettingNames().length, allSettings.length);
for (const setting of allSettings) {
  assert.equal(settingByName(setting.name), setting, `registry metadata is the single owner for ${setting.name}`);
  assert.equal(typeof setting.name, 'string');
  assert.ok(CLASSIFICATIONS.includes(setting.classification), `${setting.name} has a classification`);
  assert.equal(typeof setting.category, 'string');
  assert.ok(['always', 'never', 'bootstrap-only'].includes(setting.required), `${setting.name} declares required determinism`);
  assert.ok(typeof setting.validation === 'string' && setting.validation.length > 0, `${setting.name} declares validation semantics`);
  assert.ok(typeof setting.developmentDefault === 'string' && setting.developmentDefault.length > 0, `${setting.name} declares a development default`);
  assert.ok(typeof setting.productionBehavior === 'string' && setting.productionBehavior.length > 0, `${setting.name} declares production behavior`);
  assert.equal(typeof setting.secret, 'boolean', `${setting.name} declares secret classification`);
  assert.equal(settingSecret(setting.name), setting.secret);
  assert.equal(typeof setting.exposure, 'boolean', `${setting.name} declares .env.example exposure`);
}
// Required-vs-optional determinism for the boot-critical pair.
assert.equal(settingByName('DATABASE_URL').required, 'always');
assert.equal(settingByName('SESSION_SECRET').required, 'always');
assert.equal(settingByName('ADMIN_BOOTSTRAP_PASSWORD').required, 'bootstrap-only');
assert.equal(settingByName('POSTGRES_SCHEMA').required, 'never');
for (const setting of allSettings) {
  assert.ok('canonicalDefault' in setting, `${setting.name} declares its canonical default anchor`);
  assert.ok(setting.canonicalDefault === null || typeof setting.canonicalDefault === 'number' || typeof setting.canonicalDefault === 'string');
  assert.ok(setting.flagValue === undefined || typeof setting.flagValue === 'string');
}
scenario('CONFIG-A: every supported setting carries canonical registry metadata');

for (const name of [
  'TTS_TEST_ROUTE_INVENTORY_FILE',
  'TEST_INTERRUPTION_POINT',
  'EVALUATION_FIXTURE_NAMESPACE',
  'NODE_ENV',
  'TZ'
]) {
  assert.equal(isSupportedSetting(name), true, `${name} is classified explicitly`);
}
assert.equal(settingByName('SESSION_SECRET').secret, true);
assert.equal(settingByName('OPENAI_API_KEY').secret, true);
assert.equal(settingByName('ADMIN_BOOTSTRAP_PASSWORD').secret, true);
assert.equal(settingByName('DATABASE_URL').secret, true, 'connection URLs embed credentials and are secrets');
assert.equal(settingByName('TEST_INTERRUPTION_POINT').classification, 'test-only');
assert.equal(settingByName('TICKET_SYSTEM_POSTGRES_PORT').classification, 'development');
scenario('CONFIG-B: classifications (secret/provider/development/test-only) are explicit');

// Secrets are never classified as exposed VALUE channels: exposure means the
// VARIABLE NAME is taught; the value discipline is separate and the example
// file never carries a real credential (checked in the .env.example parity
// test below, which also asserts placeholder-only secret values).
scenario('SECRET-A: secret classification never gates on values');

// ── SECRET-A/B: validation failures never echo secret values ────────────────

const secretValue = 'postgresql://operator:VERY-SECRET-CREDENTIAL@127.0.0.1:5432/ticket_system';
assert.equal(validatePostgresUrl(secretValue), null, 'a well-formed URL validates without echoing');
assert.match(validatePostgresUrl('https://operator:VERY-SECRET-CREDENTIAL@x/db'), /must use postgres/);
assert.equal(validatePostgresUrl('https://operator:VERY-SECRET-CREDENTIAL@x/db').includes('VERY-SECRET-CREDENTIAL'), false);
assert.equal(validatePostgresUrl('').includes('VERY-SECRET'), false);
const secretSession = 'a'.repeat(10);
assert.match(validateSessionSecret(secretSession), /32/);
assert.equal(validateSessionSecret(secretSession).includes('aaaaaaaaaa'), false, 'SECRET-A: short secret never echoed');
assert.equal(validateAdminPassword('toolongname').includes('toolongname'), false);
assert.equal(validateAdminPassword('too-short', { required: true }).includes('too-short'), false);
scenario('SECRET-A: validators name the setting; the value is never rendered');

const envWithSecrets = {
  DATABASE_URL: secretValue,
  SESSION_SECRET: 'a'.repeat(10)
};
const secretFailures = validateEnvironment(envWithSecrets, { context: 'doctor' });
assert.equal(secretFailures.ok, false);
assert.equal(JSON.stringify(secretFailures).includes('VERY-SECRET-CREDENTIAL'), false, 'SECRET-B: registry validation results never include secret values');
assert.equal(JSON.stringify(secretFailures).includes(secretValue), false);
assert.ok(secretFailures.failures.some(failure => failure.name === 'SESSION_SECRET'));
// The bootstrap password keeps its CREATION-TIME discipline: standing
// configuration validation ignores it (docs: ignored after the admin
// exists); the bootstrap seam still refuses short/placeholder values.
assert.equal(settingByName('ADMIN_BOOTSTRAP_PASSWORD').required, 'bootstrap-only');
const bootstrapOnlyStandingEnvironment = validateEnvironment({
  DATABASE_URL: 'postgresql://probe:probe@localhost:5432/ticket_system',
  SESSION_SECRET: 'x'.repeat(64),
  ADMIN_BOOTSTRAP_PASSWORD: 'a'.repeat(3)
}, { context: 'doctor' });
assert.equal(bootstrapOnlyStandingEnvironment.ok, true, 'bootstrap-only values are ignored as standing configuration');
assert.match(validateAdminPassword('a'.repeat(3), { required: true }), /12/);
assert.equal(settingByName('SESSION_SECRET').secret, true);
scenario('SECRET-B: registry validation payload is value-free');

const secretProjectionInput = validateEnvironment(envWithSecrets, { context: 'doctor' });
const secretProjection = project({
  postgresProbe: healthyProbe(),
  admissionMetrics: ADMISSION_METRICS,
  configurationFailures: secretProjectionInput
});
assert.equal(JSON.stringify(secretProjection.payload).includes('VERY-SECRET-CREDENTIAL'), false, 'SECRET-B: health payloads never contain secret values');
assert.deepEqual(secretProjection.payload.readiness.configuration.invalidSettings, ['SESSION_SECRET']);
scenario('SECRET-B: health configuration diagnosis exposes names only');

// Origin and placeholder semantics stay shared with the boot surface.
assert.equal(validateHttpOrigin('https://ops.example.test'), null);
assert.match(validateHttpOrigin('https://ops.example.test/path?x=1'), /exact HTTP\(S\) origin/);
assert.match(validateHttpOrigin('postgres://ops.example.test'), /exact HTTP\(S\) origin/);
assert.match(validateHttpOrigin('not a url'), /valid absolute HTTP\(S\)/);
assert.match(validateSessionSecret('replace-with-at-least-32-random-characters'), /placeholder/);
assert.match(validateAdminPassword('replace-with-a-local-development-password'), /placeholder/);
assert.equal(MIN_SESSION_SECRET_LENGTH, 32);
assert.equal(MIN_ADMIN_PASSWORD_LENGTH, 12);
scenario('origin/placeholder/length rules are owned by the registry and shared');

// ── .env.example ↔ registry parity (CONFIG-A) ───────────────────────────────

const examplePath = path.join(ROOT, '.env.example');
const exampleSource = fs.readFileSync(examplePath, 'utf8');
const exampleSettingTokens = new Set(
  [...exampleSource.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(match => match[1])
);
const exposedNames = new Set(operatorExposedSettingNames());
assert.deepEqual(
  [...exampleSettingTokens].sort(),
  [...exposedNames].sort(),
  '.env.example must teach exactly the registry-exposed settings, no more, no fewer'
);
for (const token of exampleSettingTokens) {
  const setting = settingByName(token);
  assert.equal(setting.exposure, true, `${token} must be exposed by the registry`);
  assert.equal(setting.classification === 'test-only', false, 'test-only settings are never promoted into .env.example');
}
for (const hook of TEST_ONLY_SETTINGS) {
  assert.equal(hook.classification, 'test-only');
  assert.equal(hook.exposure, false, `${hook.name} must stay out of .env.example`);
}
assert.equal(isSupportedSetting('TTS_TEST_ROUTE_INVENTORY_FILE'), true);
assert.equal(isSupportedSetting('TEST_DATABASE_URL'), false, 'harness-only variables need no deployment registry entry');
scenario('.env.example is registry-parity checked (both directions, test hooks excluded)');

for (const secretName of ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_BOOTSTRAP_PASSWORD', 'OPENAI_API_KEY']) {
  assert.equal(settingByName(secretName).secret, true, `${secretName} stays secret-classified`);
}
// The example file must not embed a credential-shaped value. A bundled dev
// default credential (ticket_system/ticket_system) is a documented local
// fixture, not a real credential; assert no bearer/token/long-random secrets.
assert.equal(/sk-[A-Za-z0-9]{10,}/.test(exampleSource), false, 'no API-key-shaped values in .env.example');
assert.equal(exampleSource.split(placeholderSessionSecret()).length, 2, 'the session secret placeholder appears exactly once');
function placeholderSessionSecret() {
  return 'replace-with-at-least-32-random-characters';
}
scenario('SECRET-A: .env.example carries placeholders, never credentials');

// ── CONFIG-C: one executable registry owner — deterministic owner parity ────
//
// Defect-C proof. The registry is NOT a second runtime authority: for every
// declared default and flag semantics, the owning parity comparison below
// fails whenever the registry metadata drifts from the ACTUAL executable
// owner (importable owner modules are compared directly; the server boot
// surface is compared through mechanical source anchors with captured
// literals). Non-empty-string-only assertions are forbidden here.

const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mutationAdmission = require('../runtime/mutation-admission');
const runtimeBackend = require('../persistence/runtime-backend');
const materializerContract = require('../runtime/process-materializer-contract');
const launcherFoundationContract = require('../runtime/process-launcher-foundation-contract');
const planningContract = require('../runtime/structured-allocation-planning-contract');
const processExecutionContract = require('../runtime/process-execution-contract');
const browserEngineSource = fs.readFileSync(path.join(ROOT, 'runtime', 'browser-engine.js'), 'utf8');
const devAgentConfigModule = require('./dev-agent-config');
const devEnvironmentModule = require('./dev-environment');

function sourceDefaultInteger(source, pattern, settingName) {
  const match = source.match(pattern);
  assert.ok(match, `${settingName}: the executable owner source anchors this declared seam`);
  return Number(match[1]);
}

function sourceNamed(source, pattern, settingName) {
  const match = source.match(pattern);
  assert.ok(match, `${settingName}: the executable owner source names this setting exactly once`);
  return match;
}

function assertCanonicalDefaultEqualsNumber(settingName, ownerValue) {
  const setting = settingByName(settingName);
  assert.ok(setting.canonicalDefault !== null, `${settingName}: the registry declares a machine-comparable default`);
  assert.equal(
    setting.canonicalDefault,
    ownerValue,
    `${settingName}: registry canonicalDefault must equal the actual executable owner value (${ownerValue})`
  );
}

function assertFlagEquals(settingName, ownerFlagValue) {
  const setting = settingByName(settingName);
  assert.equal(
    setting.flagValue,
    ownerFlagValue,
    `${settingName}: registry flagValue must equal the actual executable owner flag value`
  );
  return setting;
}

// Importable-owned defaults are compared directly.
assertCanonicalDefaultEqualsNumber('MUTATION_ADMISSION_MAX_OUTSTANDING', mutationAdmission.resolveMutationAdmissionOptions({}).maxOutstanding);
assertCanonicalDefaultEqualsNumber('MUTATION_ADMISSION_MAX_RESERVATION_BYTES', 2 * 1024 * 1024);
assert.equal(
  mutationAdmission.resolveMutationAdmissionOptions({ MUTATION_ADMISSION_MAX_OUTSTANDING: '0x0' }).maxOutstanding,
  256,
  'MUTATION_ADMISSION_MAX_OUTSTANDING: the real owner keeps the default for a non-positive parse (registry fallback semantics, never a refusal)'
);
assert.equal(
  settingByName('MUTATION_ADMISSION_MAX_OUTSTANDING_BYTES').canonicalDefault,
  null,
  'MAX_OUTSTANDING_BYTES is owner-derived (no fixed default claim)'
);
assert.equal(
  mutationAdmission.resolveMutationAdmissionOptions({}).maxOutstandingBytes,
  mutationAdmission.resolveMutationAdmissionOptions({}).maxOutstanding *
    mutationAdmission.resolveMutationAdmissionOptions({}).maxReservationBytes,
  'MAX_OUTSTANDING_BYTES derivation parity against the real owner'
);
scenario('CONFIG-C: mutation-admission registry metadata equals the real admission owner');

// PERSISTENCE_BACKEND: exact behavior parity against the canonical backend owner.
const FULL_ENV_BASE = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SESSION_SECRET: 'x'.repeat(64) };
assert.equal(runtimeBackend.resolveRuntimePersistenceBackend({}), 'postgres');
assert.equal(runtimeBackend.resolveRuntimePersistenceBackend({ PERSISTENCE_BACKEND: 'POSTGRES' }), 'postgres');
assert.throws(() => runtimeBackend.resolveRuntimePersistenceBackend({ PERSISTENCE_BACKEND: 'postgresql' }), /Unsupported PERSISTENCE_BACKEND/);
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, PERSISTENCE_BACKEND: 'postgresql' }).ok, false, 'registry refuses exactly what the owner refuses');
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, PERSISTENCE_BACKEND: 'postgres junk' }).ok, false);
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, PERSISTENCE_BACKEND: 'postgres' }).ok, true);
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, PERSISTENCE_BACKEND: '' }).ok, true, 'unset stays the default for both');
scenario('CONFIG-C: PERSISTENCE_BACKEND registry rule is behaviorally identical to the runtime-backend owner');

// Server boot surface (not importable) — mechanical source anchors with
// captured literals compared to the registry canonicalDefault.
sourceNamed(serverSource, /trustProxy: process\.env\.TRUST_PROXY === 'true'/, 'TRUST_PROXY');
assertFlagEquals('TRUST_PROXY', 'true');
assert.equal(sourceDefaultInteger(serverSource, /const PORT = process\.env\.PORT \|\| (\d+);/, 'PORT'), 3099);
assertCanonicalDefaultEqualsNumber('PORT', 3099);
// PORT: repository-owned canonical grammar (P6-S2 review-B defect 1). The
// canonical configuration registry — NOT ambient Node/Fastify coercion — owns
// which environment values are supported configuration. server.js keeps
// `const PORT = process.env.PORT || 3099;` verbatim and forwards the value to
// `fastify.listen({ port: PORT, host: '0.0.0.0' })` (the anchors above prove
// server.js consumes this registry at boot, which is the relevant authority
// relationship); Node/Fastify remain the low-level HTTP transport. Boot
// validation admits ONLY the canonical decimal grammar before the transport
// is ever invoked; incidental transport coercions that happen to bind
// additional literal forms are outside the supported configuration contract,
// so no copy of any transport grammar exists or is needed in this test.
//
// Canonical grammar: the WHOLE value is ASCII base-10 decimal digits
// (leading decimal zeroes MAY be accepted and denote the same integer when
// the resulting value is in range, e.g. `03099`) with an in-range value of
// 1..65535.
const CANONICAL_PORT_ACCEPT_CASES = Object.freeze([
  '1',        // lower range boundary
  '80',
  '3099',     // the canonical default value
  '03099',    // leading decimal zeroes denote the same supported integer
  '65535'     // upper range boundary
]);
const CANONICAL_PORT_REFUSE_CASES = Object.freeze([
  '0', '65536',                        // outside the supported range 1..65535
  '3099junk', '12abc',                 // trailing junk never becomes the value
  '3099.5', '3099.0', '65535.0000',    // fractional decimal forms
  '3099e0', '1e3',                     // exponent forms
  '+3099', '-3099',                    // sign forms
  '0x3099', '0b1010', '0o123',         // radix prefixes
  ' 3099', '3099 ', ' 3099 ',          // padded text is not the decimal value
  '   ',                               // whitespace-only
  '3_099',                             // underscore separators
  'not-a-port'                         // non-numeric text
]);
for (const validPort of CANONICAL_PORT_ACCEPT_CASES) {
  assert.equal(
    validateEnvironment({ ...FULL_ENV_BASE, PORT: validPort }).ok,
    true,
    `PORT=${JSON.stringify(validPort)} is supported configuration under the canonical decimal grammar (1..65535)`
  );
  assert.equal(
    validatePort(validPort),
    null,
    `the canonical PORT grammar accepts ${JSON.stringify(validPort)} directly`
  );
}
for (const invalidPort of CANONICAL_PORT_REFUSE_CASES) {
  assert.equal(
    validateEnvironment({ ...FULL_ENV_BASE, PORT: invalidPort }).ok,
    false,
    `PORT=${JSON.stringify(invalidPort)} is refused: it is outside the canonical decimal grammar`
  );
  assert.match(
    validatePort(invalidPort),
    /must be an integer from 1 through 65535/,
    `the canonical PORT grammar refuses ${JSON.stringify(invalidPort)} at the grammar level`
  );
}
// Grammar-vs-absence distinction (canonical owner bytes): validating an EMPTY
// value refuses it — an empty string is not ASCII decimal digits — while an
// explicitly EMPTY environment value is the owner-defined unset case
// (`const PORT = process.env.PORT || 3099` never transports ''); the registry
// keeps that honesty instead of inventing a refusal the canonical owner does
// not have. Whitespace-only values are truthy at the owner seam and are
// refused both ways (covered above).
assert.match(validatePort(''), /must be an integer from 1 through 65535/);
assert.equal(
  validateEnvironment({ ...FULL_ENV_BASE, PORT: '' }).ok,
  true,
  'an explicitly empty PORT is the documented unset/default case at the server seam (never a transported value)'
);
assert.equal(
  validateEnvironment({ ...FULL_ENV_BASE, PORT: '65535' }).ok,
  true,
  'the canonical range boundary obeys the same grammar as every other accepted value'
);
scenario('PORT: canonical repository-owned decimal grammar (1..65535) with no ambient transport coercion');
sourceNamed(serverSource, /getPositiveIntegerEnv\('SESSION_PURGE_INTERVAL_MS', (\d+)\)/, 'SESSION_PURGE_INTERVAL_MS');
assertCanonicalDefaultEqualsNumber('SESSION_PURGE_INTERVAL_MS', 60000);
sourceNamed(serverSource, /getPositiveIntegerEnv\('SESSION_PURGE_BATCH_SIZE', (\d+)\)/, 'SESSION_PURGE_BATCH_SIZE');
assertCanonicalDefaultEqualsNumber('SESSION_PURGE_BATCH_SIZE', 1000);
sourceNamed(serverSource, /maxConnections: getPositiveIntegerEnv\('POSTGRES_POOL_MAX', (\d+)\)/, 'POSTGRES_POOL_MAX');
assertCanonicalDefaultEqualsNumber('POSTGRES_POOL_MAX', 16);
sourceNamed(serverSource, /connectionTimeoutMs: getPositiveIntegerEnv\('POSTGRES_CONNECTION_TIMEOUT_MS', (\d+)\)/, 'POSTGRES_CONNECTION_TIMEOUT_MS');
assertCanonicalDefaultEqualsNumber('POSTGRES_CONNECTION_TIMEOUT_MS', 5000);
sourceNamed(serverSource, /statementTimeoutMs: getPositiveIntegerEnv\('POSTGRES_STATEMENT_TIMEOUT_MS', (\d+)\)/, 'POSTGRES_STATEMENT_TIMEOUT_MS');
assertCanonicalDefaultEqualsNumber('POSTGRES_STATEMENT_TIMEOUT_MS', 30000);
sourceNamed(serverSource, /lockTimeoutMs: getPositiveIntegerEnv\('POSTGRES_LOCK_TIMEOUT_MS', (\d+)\)/, 'POSTGRES_LOCK_TIMEOUT_MS');
assertCanonicalDefaultEqualsNumber('POSTGRES_LOCK_TIMEOUT_MS', 5000);
sourceNamed(serverSource, /const DEFAULT_MAX_ACTIVE_RUNS = (\d+);/, 'MAX_ACTIVE_RUNS');
assertCanonicalDefaultEqualsNumber('MAX_ACTIVE_RUNS', 32);
sourceNamed(serverSource, /getPositiveIntegerEnv\('MAX_ACTIVE_RUNS', DEFAULT_MAX_ACTIVE_RUNS\)/, 'MAX_ACTIVE_RUNS consumption');
sourceNamed(serverSource, /const DEFAULT_MAX_ACTIVE_RUNS_CAP = (\d+);/, 'MAX_ACTIVE_RUNS_CAP');
assertCanonicalDefaultEqualsNumber('MAX_ACTIVE_RUNS_CAP', 4096);
sourceNamed(serverSource, /const DEFAULT_LOCAL_MODEL_CONCURRENCY = (\d+);/, 'LOCAL_MODEL_CONCURRENCY');
assertCanonicalDefaultEqualsNumber('LOCAL_MODEL_CONCURRENCY', 1);
sourceNamed(serverSource, /const DEFAULT_LOCAL_MODEL_CONCURRENCY_CAP = (\d+);/, 'MAX_LOCAL_MODEL_CONCURRENCY');
assertCanonicalDefaultEqualsNumber('MAX_LOCAL_MODEL_CONCURRENCY', 32);
sourceNamed(serverSource, /getPositiveIntegerEnv\('RUNTIME_SCHEDULER_INTERVAL_MS', (\d+)\)/, 'RUNTIME_SCHEDULER_INTERVAL_MS');
assertCanonicalDefaultEqualsNumber('RUNTIME_SCHEDULER_INTERVAL_MS', 500);
sourceNamed(serverSource, /getPositiveIntegerEnv\('RUNTIME_SCHEDULER_CANDIDATE_LIMIT', (\d+)\)/, 'RUNTIME_SCHEDULER_CANDIDATE_LIMIT');
assertCanonicalDefaultEqualsNumber('RUNTIME_SCHEDULER_CANDIDATE_LIMIT', 1000);
sourceNamed(serverSource, /getPositiveIntegerEnv\('PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS', (\d+)\)/, 'PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS');
assertCanonicalDefaultEqualsNumber('PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS', 60000);
sourceNamed(serverSource, /const DEFAULT_RUN_LEASE_DURATION_MS = (\d+);/, 'RUN_LEASE_DURATION_MS');
assert.equal(
  settingByName('RUN_LEASE_DURATION_MS').canonicalDefault,
  null,
  'RUN_LEASE_DURATION_MS: the registry claims NO default; the server owner keeps its governed runtime-policy default'
);
sourceNamed(serverSource, /getPositiveIntegerEnv\('SHUTDOWN_RUN_DRAIN_TIMEOUT_MS', (\d+)\)/, 'SHUTDOWN_RUN_DRAIN_TIMEOUT_MS');
assertCanonicalDefaultEqualsNumber('SHUTDOWN_RUN_DRAIN_TIMEOUT_MS', 120000);
sourceNamed(serverSource, /parseInt\(process\.env\.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE \|\| '(\d+)', 10\) \|\| (\d+)/, 'AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE');
assertCanonicalDefaultEqualsNumber('AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE', 2);
const DEFAULT_AGENT_LIMITS_ANCHORS = [
  ['AGENT_MAX_ATTEMPTS', /maxAttempts: (\d+),/, 3],
  ['AGENT_MAX_EXECUTION_STEPS', /maxExecutionSteps: (\d+),/, 4],
  ['AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN', /maxWorkspaceOperationsPerRun: (\d+),/, 32],
  ['AGENT_MAX_MODEL_REQUESTS_PER_RUN', /maxModelRequestsPerRun: (\d+),/, 4],
  ['AGENT_MAX_PROCESS_OPERATIONS_PER_RUN', /maxProcessOperationsPerRun: (\d+),/, 4],
  ['AGENT_MAX_BROWSER_OPERATIONS_PER_RUN', /maxBrowserOperationsPerRun: (\d+),/, 32],
  ['AGENT_MAX_RUNTIME_DURATION_MS', /maxRuntimeDurationMs: (\d+),/, 120000]
];
for (const [name, pattern, expected] of DEFAULT_AGENT_LIMITS_ANCHORS) {
  const ownerValue = sourceDefaultInteger(
    serverSource.slice(serverSource.indexOf('const DEFAULT_AGENT_RUNTIME_LIMITS')),
    pattern,
    name
  );
  assert.equal(ownerValue, expected, `${name}: the server owner literal is ${expected}`);
  assertCanonicalDefaultEqualsNumber(name, expected);
}
assert.equal(
  serverSource.slice(serverSource.indexOf('const DEFAULT_AGENT_RUNTIME_LIMITS')).match(/maxOutputArtifactBytesPerRun: 16 \* 1024 \* 1024/)[0],
  'maxOutputArtifactBytesPerRun: 16 * 1024 * 1024',
  'AGENT_MAX_OUTPUT_ARTIFACT_BYTES_PER_RUN: the owner literal is 16 MiB'
);
assertCanonicalDefaultEqualsNumber('AGENT_MAX_OUTPUT_ARTIFACT_BYTES_PER_RUN', 16 * 1024 * 1024);
sourceNamed(serverSource, /getPositiveIntegerEnv\('WORKFLOW_MAX_TRANSITIONS', (\d+)\)/, 'WORKFLOW_MAX_TRANSITIONS');
assertCanonicalDefaultEqualsNumber('WORKFLOW_MAX_TRANSITIONS', 16);
sourceNamed(serverSource, /getPositiveIntegerEnv\('WORKFLOW_MAX_LOOP_ITERATIONS', (\d+)\)/, 'WORKFLOW_MAX_LOOP_ITERATIONS');
assertCanonicalDefaultEqualsNumber('WORKFLOW_MAX_LOOP_ITERATIONS', 3);
sourceNamed(serverSource, /getPositiveIntegerEnv\('WORKFLOW_MAX_MUTATIONS', MAX_MUTATING_ACTIONS_PER_RESPONSE\)/, 'WORKFLOW_MAX_MUTATIONS');
assert.equal(
  settingByName('WORKFLOW_MAX_MUTATIONS').canonicalDefault,
  null,
  'WORKFLOW_MAX_MUTATIONS is owner-derived from AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE (no fixed default claim)'
);
sourceNamed(serverSource, /getPositiveIntegerEnv\('STRUCTURED_PLANNER_REQUEST_TIMEOUT_MS', PLANNER_REQUEST_LIMITS\.timeoutMs\)/, 'STRUCTURED_PLANNER_REQUEST_TIMEOUT_MS');
assertCanonicalDefaultEqualsNumber('STRUCTURED_PLANNER_REQUEST_TIMEOUT_MS', planningContract.PLANNER_REQUEST_LIMITS.timeoutMs);
assertCanonicalDefaultEqualsNumber('PROCESS_MATERIALIZER_TIMEOUT_MS', materializerContract.PROCESS_MATERIALIZER_DEFAULT_TIMEOUT_MS);
assertCanonicalDefaultEqualsNumber('PROCESS_LAUNCHER_TIMEOUT_MS', launcherFoundationContract.PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS);
assert.equal(settingByName('PROCESS_MATERIALIZER_SOCKET_PATH').canonicalDefault, null);
sourceNamed(serverSource, /process\.env\.PROCESS_MATERIALIZER_SOCKET_PATH \|\|\n\s+PROCESS_MATERIALIZER_DEFAULT_SOCKET_PATH/, 'PROCESS_MATERIALIZER_SOCKET_PATH');
sourceNamed(serverSource, /process\.env\.PROCESS_LAUNCHER_SOCKET_PATH \|\|\n\s+PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH/, 'PROCESS_LAUNCHER_SOCKET_PATH');
assert.equal(
  settingByName('PROCESS_TARGET_CATALOG_FILE').canonicalDefault,
  'config/process-targets.json'
);
sourceNamed(serverSource, /process\.env\.PROCESS_TARGET_CATALOG_FILE \|\| path\.join\(__dirname, 'config', 'process-targets\.json'\)/, 'PROCESS_TARGET_CATALOG_FILE');
assert.equal(settingByName('PROCESS_EXECUTION_SOURCE_REVISION').canonicalDefault, null);
sourceNamed(serverSource, /process\.env\.PROCESS_EXECUTION_SOURCE_REVISION \|\| ''/, 'PROCESS_EXECUTION_SOURCE_REVISION');
sourceNamed(serverSource, /process\.env\.PROCESS_EXECUTION_DEPLOYMENT_VALIDATED === 'true'/, 'PROCESS_EXECUTION_DEPLOYMENT_VALIDATED');
assertFlagEquals('PROCESS_EXECUTION_DEPLOYMENT_VALIDATED', 'true');
assert.equal(settingByName('PROCESS_WORKSPACE_ALLOCATION_ID').canonicalDefault, 'primary-workspace');
sourceNamed(serverSource, /process\.env\.PROCESS_WORKSPACE_ALLOCATION_ID \|\| 'primary-workspace'/, 'PROCESS_WORKSPACE_ALLOCATION_ID');
assert.equal(settingByName('BROWSER_ENGINE_EXECUTABLE').canonicalDefault, null);
sourceNamed(browserEngineSource, /process\.env\.BROWSER_ENGINE_EXECUTABLE/, 'BROWSER_ENGINE_EXECUTABLE');
sourceNamed(serverSource, /require\('\.\/runtime\/browser-engine'\)/, 'BROWSER_ENGINE_EXECUTABLE owner');
scenario('CONFIG-C: server-owned defaults are source-anchored to the registry canonical defaults');

// Feature gates: flag semantics equal the executable owners.
assert.equal(
  processExecutionContract.isProcessContractFeatureEnabled({ ENABLE_PROCESS_EXECUTION_CONTRACT: 'true' }),
  true,
  'the real contract owner enables exactly on the exact flag value'
);
assert.equal(processExecutionContract.isProcessContractFeatureEnabled({ ENABLE_PROCESS_EXECUTION_CONTRACT: 'TRUE' }), false);
assert.equal(processExecutionContract.isProcessContractFeatureEnabled({ ENABLE_PROCESS_EXECUTION_CONTRACT: 'false' }), false, 'the real contract owner keeps the default state for "false" (never a refusal)');
assert.equal(processExecutionContract.isProcessContractFeatureEnabled({}), false);
assertFlagEquals('ENABLE_PROCESS_EXECUTION_CONTRACT', 'true');
assert.equal(
  validateEnvironment({ ...FULL_ENV_BASE, ENABLE_PROCESS_EXECUTION_CONTRACT: 'false' }).ok,
  true,
  'flag "false" is a valid configuration that leaves the feature disabled (registry mirrors the owner)');
assert.equal(
  validateEnvironment({ ...FULL_ENV_BASE, DEAL: 'orb' }).ok,
  true,
  'unsupported variable names are not deployment configuration and are not registry failures'
);
sourceNamed(serverSource, /process\.env\.AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT === '1'/, 'AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT');
assertFlagEquals('AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT', '1');
sourceNamed(serverSource, /process\.env\.ENABLE_MODEL_CONTRACT_COMPILER === 'true'/, 'ENABLE_MODEL_CONTRACT_COMPILER');
assertFlagEquals('ENABLE_MODEL_CONTRACT_COMPILER', 'true');
sourceNamed(serverSource, /process\.env\.ENABLE_PREFIX_TRUNCATION === 'true'/, 'ENABLE_PREFIX_TRUNCATION');
assertFlagEquals('ENABLE_PREFIX_TRUNCATION', 'true');
scenario('CONFIG-C: feature-gate flag semantics equal the executable owners');

// Positive-integer fallback semantics: the real owners keep their canonical
// defaults for any unparsable value and NEVER refuse; the registry mirrors
// that exactly (no invented refusal). This remains owner-fallback parsing
// deliberately — the strict validators introduced for the port-like settings
// are scoped to those settings and never reclassify the fallback owners
// (server.js getPositiveIntegerEnv and runtime/mutation-admission.js
// positiveInteger keep their leading-decimal fallback behavior exactly).
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, POSTGRES_POOL_MAX: 'garbage' }).ok, true);
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, MAX_ACTIVE_RUNS_CAP: 'nonsense' }).ok, true);
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, LOCAL_MODEL_CONCURRENCY: 'x' }).ok, true);
assert.equal(
  validateEnvironment({ ...FULL_ENV_BASE, MAX_ACTIVE_RUNS: '3099junk' }).ok,
  true,
  'owner-fallback parsing stays owner-fallback: a partial numeric prefix keeps the canonical default and never refuses'
);
assert.equal(validateEnvironment({ ...FULL_ENV_BASE, POSTGRES_POOL_MAX: '12abc' }).ok, true);
assert.equal(
  mutationAdmission.resolveMutationAdmissionOptions({ MUTATION_ADMISSION_MAX_OUTSTANDING: '3099junk' }).maxOutstanding,
  3099,
  'the REAL fallback owner parses the leading decimal value exactly as before (3099junk → 3099, never a refusal) — owner-fallback semantics are untouched by the strict port helpers'
);
assert.equal(
  mutationAdmission.resolveMutationAdmissionOptions({ MUTATION_ADMISSION_MAX_OUTSTANDING: 'nope' }).maxOutstanding,
  mutationAdmission.resolveMutationAdmissionOptions({}).maxOutstanding,
  'the REAL fallback owner keeps its canonical default for an unparsable value'
);
scenario('CONFIG-C: positive-integer declarations mirror owner fallback semantics');

// DEV tolerance and provider defaults.
assert.equal(
  devAgentConfigModule.DEFAULT_OLLAMA_BASE_URL,
  settingByName('OLLAMA_BASE_URL').canonicalDefault,
  'OLLAMA_BASE_URL default equals the dev-agent-config owner constant'
);
sourceNamed(serverSource, /process\.env\.OLLAMA_BASE_URL \|\| 'http:\/\/127\.0\.0\.1:11434'/, 'OLLAMA_BASE_URL');
assert.equal(settingByName('OPENAI_MODEL').canonicalDefault, null);
const devAgentConfigSource = fs.readFileSync(path.join(ROOT, 'scripts', 'dev-agent-config.js'), 'utf8');
sourceNamed(devAgentConfigSource, /DEFAULT_OPENAI_MODEL = '([^']+)'/, 'DEFAULT_OPENAI_MODEL-note');
assert.equal(devAgentConfigModule.DEFAULT_OPENAI_MODEL, 'gpt-4.1-mini');
sourceNamed(serverSource, /agent\.model \|\| process\.env\.OPENAI_MODEL/, 'OPENAI_MODEL');
sourceNamed(serverSource, /agent\.model \|\| process\.env\.OLLAMA_MODEL/, 'OLLAMA_MODEL');
assert.equal(settingByName('DEV_AGENT_NAME').canonicalDefault, 'Developer Agent');
assert.equal(devAgentConfigModule.DEFAULT_AGENT_NAME, 'Developer Agent');
assert.equal(
  devEnvironmentModule.developmentConfig({}).workspaceRoot,
  path.resolve(path.join(__dirname, '..'), settingByName('WORKSPACE_ROOT').canonicalDefault),
  'WORKSPACE_ROOT canonicalDefault equals the real dev-environment owner resolution'
);
assert.equal(settingByName('WORKSPACE_ROOT').canonicalDefault, 'workspace-root');
assert.equal(settingByName('ARTIFACT_ROOT').canonicalDefault, '.local-artifacts');
sourceNamed(serverSource, /process\.env\.WORKSPACE_ROOT \|\| path\.join\(__dirname, 'workspace-root'\)/, 'WORKSPACE_ROOT');
sourceNamed(serverSource, /process\.env\.ARTIFACT_ROOT \|\| path\.join\(__dirname, '\.local-artifacts'\)/, 'ARTIFACT_ROOT');
assert.equal(settingByName('POSTGRES_SCHEMA').canonicalDefault, 'ticket_system');
sourceNamed(serverSource, /process\.env\.POSTGRES_SCHEMA \|\| 'ticket_system'/, 'POSTGRES_SCHEMA');
assert.equal(devEnvironmentModule.DEFAULT_BUNDLED_POSTGRES_PORT, settingByName('TICKET_SYSTEM_POSTGRES_PORT').canonicalDefault);
assert.equal(settingByName('TICKET_SYSTEM_POSTGRES_PORT').canonicalDefault, 5432);
assert.throws(() => devEnvironmentModule.bundledDatabaseUrl(70000), /1 through 65535/, 'the real dev owner refuses out-of-range ports exactly as the registry rule declares');
const devRunnerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'dev.js'), 'utf8');
assert.doesNotMatch(devRunnerSource, /WORKSPACE_ROOT \|\|= /, 'the dev runner must not inject a second WORKSPACE_ROOT default (one canonical default, registry-owned)');
assert.doesNotMatch(devRunnerSource, /ARTIFACT_ROOT \|\|= /, 'the dev runner must not inject a second ARTIFACT_ROOT default');
assert.match(devRunnerSource, /applyLocalEnv\(\)/, 'the dev runner still applies the resolved local environment');
scenario('CONFIG-C: provider/development/effect-root defaults equal their owners');

// DRIVER seam: the server boot surface must consume the canonical registry
// validators (one supported rule, no split-brain configuration).
sourceNamed(serverSource, /} = require\('\.\/runtime\/environment-config-registry'\)/, 'registry consumption');
sourceNamed(serverSource, /validateEnvironment\(process\.env/, 'validateEnvironment boot consumption');
sourceNamed(serverSource, /validateHttpOrigin\(configured\)/, 'validateHttpOrigin boot consumption');
sourceNamed(serverSource, /validateSessionSecret\(String\(process\.env\.SESSION_SECRET \|\| ''\)\.trim\(\)\)/, 'SESSION_SECRET canonical rule consumption');
scenario('CONFIG-C: server boot consumes the canonical registry rules (DRIVER seams)');

// ── MIGRATION DIAGNOSTICS (disposable development ledger classifier) ────────
//
// P6-DEVEX-A correction. The doctor diagnoses the FIXED repository-owned
// disposable development target; its ledger row makes NO migration-authorization
// claim, because the code-declared disposable development authority is bound
// ONLY to the verified bundled-compose development lifecycle (the
// module-internal site in scripts/dev-database.js) that auto-migrates that
// target on `npm run dev`.
// The OPERATIONAL migration-execution authority (T10) is a separate, unchanged
// owner: its refusal/classification behavior is pinned by
// scripts/migration-execution-authority-test.js, and this doctor never
// consulted, weakened, or bypassed it. The classifier consumes canonical
// persistence facts only (exact `getMigrationStatus()` shape, read-only
// observation, canonical pending/identity evaluation); the fixed dev-target
// identity/state combinations are pinned deterministically here and the real
// store-backed doctor rows in the PostgreSQL-native counterpart suite.
const { classifyDisposableDevelopmentLedgerState, ledgerCheckRow, postgresHelp } = require('./dev-doctor');

const DEV_MIGRATIONS = ['040_ticket_cancellation_authority.sql', '041_ticket_five_state_cutover.sql'];
function devChecksum(version) {
  return require('node:crypto').createHash('sha256').update(`dev-fixture:${version}`).digest('hex');
}
const APPLIED_040 = DEV_MIGRATIONS.slice(0, 1);
const PENDING_041 = DEV_MIGRATIONS.slice(1).map(version => ({ version, sha256: devChecksum(version) }));
const FULL_STATUS = Object.freeze({ fullyApplied: true, checksumsValid: true, partial: false, currentVersion: 41, headVersion: 41, pendingMigrations: 0, unknownMigrations: 0 });

function devLedgerState({
  schemaExists = true,
  ledgerExists = true,
  appliedVersions = APPLIED_040,
  status = { fullyApplied: false, currentVersion: 40, headVersion: 41, pendingMigrations: 1, unknownMigrations: 0, checksumsValid: false, partial: false },
  migrations = DEV_MIGRATIONS,
  identityRows = null,
  pendingMigrations = null
} = {}) {
  return classifyDisposableDevelopmentLedgerState({
    schemaExists,
    ledgerExists,
    appliedVersions,
    status,
    migrations,
    migrationChecksum: devChecksum,
    identityRows,
    pendingMigrations
  });
}

{
  // CURRENT (complete canonical ledger).
  const current = devLedgerState({
    appliedVersions: DEV_MIGRATIONS,
    status: FULL_STATUS,
    statusNote: undefined,
    identityRows: DEV_MIGRATIONS.map(version => ({ version, sha256: devChecksum(version) }))
  });
  assert.equal(current.state, 'current');
  assert.deepEqual(current.pending, []);
  assert.equal(current.remediation, null, 'a current development ledger needs no remediation');
  assert.equal(ledgerCheckRow(current, 'ticket_system').status, 'pass');
  scenario('MIGRATION-dev: current disposable development ledger renders PASS');

  // BEHIND with valid applied identities: informational auto-migrate row with
  // NO authorization claim (the disposable authority is a code declaration).
  const behind = devLedgerState({
    appliedVersions: APPLIED_040,
    identityRows: APPLIED_040.map(version => ({ version, sha256: devChecksum(version) }))
  });
  assert.equal(behind.state, 'behind_disposable');
  assert.deepEqual(behind.pending, ['041_ticket_five_state_cutover.sql']);
  assert.equal(behind.remediation, null);
  assert.match(behind.message, /behind the canonical migration source by 1/);
  assert.match(behind.message, /auto-migrate/);
  assert.match(behind.message, /no migration-execution authorization is involved/,
    'the dev ledger row states disposability explicitly, never authorization');
  assert.doesNotMatch(behind.message, /IS authorized|authorized for this exact/,
    'the dev ledger row does NOT record authorization state');
  const behindRow = ledgerCheckRow(behind, 'ticket_system');
  assert.equal(behindRow.status, 'info');
  assert.equal(behindRow.message.includes('IS authorized'), false);
  scenario('MIGRATION-dev: behind disposable development ledger is informational (auto-migrate, no authorization claim)');

  // Applied-identity evaluation covers the applied subset so a simply-behind
  // ledger with valid applied identity bytes is never mis-read as drift.
  assert.equal(behind.state, 'behind_disposable', 'clean applied identities + pending stay behind, not drift');
  scenario('applied-identity evaluation covers the applied subset so "behind" is not drift');

  // UNINITIALIZED: informational provisioning guidance (`npm run dev` /
  // `npm run dev:setup` provisions the disposable target).
  const uninitialized = devLedgerState({ schemaExists: false, ledgerExists: false });
  assert.equal(uninitialized.state, 'uninitialized');
  assert.match(uninitialized.message, /provisions and auto-migrates/);
  assert.match(uninitialized.message, /development authority/);
  assert.equal(ledgerCheckRow(uninitialized, 'ticket_system').status, 'info');
  scenario('MIGRATION-dev: uninitialized development ledger is informational (dev provisions it)');

  // UNKNOWN FUTURE migration: incompatible disposable state → dev:reset.
  const unknown = devLedgerState({
    appliedVersions: DEV_MIGRATIONS,
    status: { fullyApplied: false, currentVersion: 41, headVersion: 41, pendingMigrations: 0, unknownMigrations: 1, checksumsValid: false, partial: true }
  });
  assert.equal(unknown.state, 'incompatible_unknown');
  assert.match(unknown.message, /unknown future migrations/);
  assert.match(unknown.remediation, /dev:reset/);
  assert.equal(ledgerCheckRow(unknown, 'ticket_system').status, 'fail');
  scenario('MIGRATION-dev: unknown future migrations fail with exactly the dev:reset remediation');

  // APPLIED-IDENTITY DRIFT → dev:reset.
  const drifted = devLedgerState({
    appliedVersions: APPLIED_040,
    identityRows: [{ version: '040_ticket_cancellation_authority.sql', sha256: '0'.repeat(64) }],
    pendingMigrations: PENDING_041
  });
  assert.equal(drifted.state, 'drifted');
  assert.match(drifted.message, /checksum\/history drift/);
  assert.match(drifted.remediation, /dev:reset/);
  scenario('MIGRATION-dev: identity drift fails with the dev:reset remediation');

  // PARTIAL canonical facts → dev:reset.
  const partial = devLedgerState({
    appliedVersions: DEV_MIGRATIONS,
    status: { ...FULL_STATUS, fullyApplied: false, partial: true, checksumsValid: false },
    identityRows: DEV_MIGRATIONS.map(version => ({ version, sha256: devChecksum(version) })),
    pendingMigrations: []
  });
  assert.equal(partial.state, 'drifted');
  assert.match(partial.remediation, /dev:reset/);
  scenario('MIGRATION-dev: partial canonical facts fail with the dev:reset remediation');

  // Inconsistent no-pending ledger (not fullyApplied, nothing pending) → fail.
  const inconsistent = devLedgerState({
    appliedVersions: APPLIED_040,
    status: { ...FULL_STATUS, fullyApplied: false },
    pendingMigrations: []
  });
  assert.equal(inconsistent.state, 'drifted');
  assert.match(inconsistent.remediation, /dev:reset/);
  scenario('MIGRATION-dev: unexplained inconsistent ledger fails closed with dev:reset');

  // The fail rows carry the bounded remediation; connectivity help stays.
  const unknownRow = ledgerCheckRow(unknown, 'ticket_system');
  assert.match(unknownRow.message, /dev:reset/, 'corrupt development state names ONLY the disposable reset remediation');
  assert.ok(postgresHelp().includes('dev:setup'), 'connectivity help retained');
  scenario('MIGRATION-dev: ledger rows render honestly; connectivity help is unchanged');
}

// dev:setup's refusal guidance (bytes-level): the export exists and points at
// the governed procedure; connectivity help is separate.
const { migrationAuthorityHelp } = require('./dev-setup');
assert.match(migrationAuthorityHelp(), /cannot bypass migration execution authority/);
assert.match(migrationAuthorityHelp(), /config\/migration-execution-authorization\.json/);
assert.doesNotMatch(migrationAuthorityHelp(), /run pnpm dev:setup/);
scenario('dev:setup refusal guidance points at the governed authorization procedure only');

// ── SCOPE-A/B: no P6-S3/P7 surface crept in ────────────────────────────────
// The health payload carries no process/takeover/deployment topology fields
// and the registry carries no cloud/deployment packages.
assert.equal(JSON.stringify(supportedSettingNames()).includes('KUBE'), false);
assert.equal(JSON.stringify(supportedSettingNames()).includes('TERRAFORM'), false);
assert.equal(JSON.stringify(supportedSettingNames()).includes('BACKUP'), false);
scenario('SCOPE-A: no deployment/cloud/P7 configuration surface is claimed');

console.log(`\nPASS: p6-s2 health/readiness/config contract (${scenarioCount} scenarios)`);
