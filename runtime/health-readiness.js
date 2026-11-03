'use strict';

// P6-S2: honest health semantics — liveness / readiness / capacity.
//
// Authority: P6 design freeze (docs/DEPLOYMENT_CONTRACT.md §6/§7 and the same
// sections of the register record). This module is the executable owner of the
// health payload projection shared by the public health routes:
//
//   Liveness — the process exists and can answer. It MUST NOT depend on
//   PostgreSQL, migration state, provider availability, work capacity, or any
//   downstream service. In the designed payloads below liveness is carried by
//   `alive: true`; a process that cannot answer at all demonstrates liveness
//   failure the way liveness probes are normally observed (connection
//   refused/timeout). No DB probe result is ever consulted for liveness.
//
//   Readiness — the process may safely receive normal application traffic.
//   Requires: PostgreSQL reachable; canonical migration ledger compatible (no
//   missing/pending migrations, no unknown future migrations); canonical
//   migration checksum identities valid; no evidence-persistence fail-closed
//   latch; required startup configuration valid; required local effect roots
//   usable for work the process may receive.
//
//   Capacity — the current work-admission/load state. Capacity is NOT
//   readiness: mutation-admission backpressure remains authoritative for
//   refusing work through its existing authority, is surfaced as capacity
//   status, and NEVER marks an otherwise-ready process unready. The old
//   503-backpressure-as-readiness behavior is a corrected P6-S2 target.
//
// Cadence: one read-only PostgreSQL probe per readiness request, by default.
// The probe reuses the canonical persistence owner —
// `PostgresRuntimeStore.getMigrationStatus()` (Mutation-free: the store opens
// the read-only transaction itself; this module never duplicates migration
// enumeration or checksum logic). No indefinite cached success, no
// startup-only truth, no mutation, no credential-bearing error text.

const { validateEnvironment } = require('./environment-config-registry');
const fs = require('fs');
const path = require('path');

const READINESS_PROJECTION_VERSION = 1;

// Readiness reason codes (stable, sanitized — never carry DB error messages,
// connection text, credentials, or filesystem paths).
const READINESS_REASON_CODES = Object.freeze({
  STARTING: 'starting',
  EVIDENCE_PERSISTENCE_LATCHED: 'evidence_persistence_latched',
  POSTGRES_UNREACHABLE: 'postgres_unreachable',
  MIGRATIONS_INCOMPATIBLE: 'migrations_incompatible',
  CONFIGURATION_INVALID: 'configuration_invalid',
  EFFECT_ROOT_UNUSABLE: 'effect_root_unusable'
});

// Canonical migration-integrity fact classification from the exact
// `PostgresRuntimeStore.getMigrationStatus()` shape. Sharing ONE classifier
// with the development doctor keeps both owners honest about the same facts.
function classifyMigrationStatus(status) {
  if (!status || typeof status !== 'object') {
    return { compatible: false, code: 'migrations_state_unavailable', compatibleState: 'unknown' };
  }
  if (status.fullyApplied === true) {
    return {
      compatible: true,
      code: 'migrations_current',
      compatibleState: 'current',
      facts: Object.freeze({
        currentVersion: status.currentVersion,
        headVersion: status.headVersion,
        pendingMigrations: status.pendingMigrations,
        unknownMigrations: status.unknownMigrations,
        checksumsValid: status.checksumsValid,
        partial: status.partial
      })
    };
  }
  const facts = {
    currentVersion: status.currentVersion,
    headVersion: status.headVersion,
    fullyApplied: status.fullyApplied,
    pendingMigrations: status.pendingMigrations,
    unknownMigrations: status.unknownMigrations,
    // On a ledger that is behind, the store's checksum field is false by
    // construction (pending migrations have no identity rows yet); it signals
    // applied-identity drift only on a ledger with zero pending migrations
    // (the store's `partial` flag).
    checksumsValid: status.checksumsValid,
    partial: status.partial
  };
  if (status.unknownMigrations > 0) {
    return { compatible: false, code: 'migrations_unknown', compatibleState: 'incompatible', facts: Object.freeze(facts) };
  }
  if (status.partial === true) {
    return { compatible: false, code: 'migrations_partial', compatibleState: 'drifted', facts: Object.freeze(facts) };
  }
  if (status.pendingMigrations > 0) {
    return { compatible: false, code: 'migrations_pending', compatibleState: 'behind', facts: Object.freeze(facts) };
  }
  return { compatible: false, code: 'migrations_state_unavailable', compatibleState: 'unknown', facts: Object.freeze(facts) };
}

// Sanitized probe failure. Raw PostgreSQL error messages can embed connection
// string credentials and host names, so only the deterministic error CODE is
// carried (e.g. ECONNREFUSED, 08006, 53300) with a bounded stable label.
function sanitizePostgresProbeError(error) {
  const code = error && error.code ? String(error.code) : null;
  return Object.freeze({
    code,
    label: code ? `postgres_probe_refused:${code}` : 'postgres_probe_refused'
  });
}

// ONE read-only probe per readiness call. Never mutates: the store opens its
// own `REPEATABLE READ READ ONLY` transaction for the migration state.
async function probePostgresReadiness(store) {
  try {
    const migrationStatus = await store.getMigrationStatus();
    return { reachable: true, migrationStatus: Object.freeze({ ...migrationStatus }) };
  } catch (error) {
    return { reachable: false, failure: sanitizePostgresProbeError(error) };
  }
}

// Required host-local effect roots. A REQUIRED effect root is usable only if
// the runtime can actually use it as its required DIRECTORY boundary:
//
//   existing configured root —
//     it IS a directory, and the process has the directory access the runtime
//     owners need (read + write + traverse). W_OK alone is NOT sufficient for
//     a directory that also requires traversal (missing X_OK made the old
//     write-only probe report a false positive);
//   missing configured root —
//     the walk upward identifies the nearest pathname component that HAS a
//     directory entry, using `lstatSync` so an occupied component is never
//     skipped out of existence: a followed existence probe vanishes behind a
//     dangling symlink ancestor and would keep walking upward, classifying
//     the root `creatable` through an occupied ancestor that a recursive
//     root creation can never traverse (dangling ancestor → ENOENT,
//     non-directory ancestor → ENOTDIR). The physically occupied component
//     is the creation boundary and recursive root creation can proceed only
//     when it resolves (through symlinks, exactly as the runtime creation
//     resolves) to a directory supporting the creation/traversal it needs
//     (write + traverse). Nothing is created here and no test files are
//     written; probing never mutates, matching
//     `fs.mkdirSync(root, { recursive: true })`-style acceptance in the
//     runtime owners without performing it;
//   occupied configured root that is NOT a directory boundary —
//     a filesystem ENTRY already places itself at the pathname, so recursive
//     root creation cannot create through it. This includes a regular file
//     and a symlink entry whose target does not resolve to a directory — the
//     DANGLING root symlink. The former existsSync-only classification
//     followed the link, saw "missing", and reported a dangling root as
//     creatable: a false positive, because `fs.mkdirSync(root,
//     { recursive: true })` cannot create through a pathname already occupied
//     by a symlink entry. Classification uses `lstatSync` (non-mutating,
//     non-following) to tell "no entry" from "entry occupies the pathname",
//     and only a target that resolves to a directory satisfies the boundary —
//     a valid symlink to a directory stays exactly as usable as the real
//     directory it resolves to. All occupied-boundary refusals share the
//     existing sanitized `not_a_directory` reason; no target or path is ever
//     exposed.
//
// The walk semantics are the ONE owner shared by the health routes, the
// development doctor, and the readiness contract, so they cannot disagree.
// No absolute path ever appears in a health response.
function effectRootReadiness(entries = []) {
  return Object.freeze(entries.map(entry => {
    const configured = path.resolve(String(entry.root));
    // Classify the configured root WITHOUT following symlinks first: a
    // followed existence probe vanishes behind a dangling symlink and cannot
    // distinguish "no entry" from "entry occupies the pathname".
    let state = 'missing'; // no directory entry at the pathname
    try {
      const entryStats = fs.lstatSync(configured);
      if (entryStats.isSymbolicLink()) {
        // An entry occupies the pathname. The required DIRECTORY boundary is
        // satisfied only when the followed TARGET resolves to a directory
        // (including a symlink chain): the runtime owners can then use it,
        // exactly as the followed-probe behavior did before. Anything else —
        // a dangling target or a target that is not a directory — keeps the
        // pathname occupied and uncreatable, so it is never creatable here.
        let followed = null;
        try {
          followed = fs.statSync(configured);
        } catch (_) {
          followed = null; // dangling (or unresolvable) symlink target
        }
        state = followed && followed.isDirectory() ? 'exists' : 'not_directory';
      } else {
        state = entryStats.isDirectory() ? 'exists' : 'not_directory';
      }
    } catch (_) {
      // No readable directory entry at the pathname: the genuinely missing
      // (or otherwise unclassifiable) root, which the parent walk classifies.
      state = 'missing';
    }
    let usable = false;
    let reason = null;
    try {
      if (state === 'exists') {
        const stats = fs.statSync(configured);
        if (!stats.isDirectory()) {
          reason = 'not_a_directory';
        } else {
          fs.accessSync(configured, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
          usable = true;
          reason = 'usable';
        }
      } else if (state === 'not_directory') {
        // The pathname is occupied by a filesystem entry that is not (and
        // cannot be created over) the required directory boundary — regular
        // file or dangling symlink — so it is never reported as creatable.
        reason = 'not_a_directory';
      } else {
        let candidate = configured;
        let parent = null;
        while (true) {
          parent = path.dirname(candidate);
          if (parent === candidate) {
            reason = 'no_existing_parent';
            break;
          }
          // NON-following ancestor inspection: the walk stops at the nearest
          // pathname component that HAS a directory entry and never skips an
          // occupied component out of existence. A followed existence probe
          // vanishes behind a dangling symlink ancestor (the followed target
          // is missing) and would keep walking upward to the first REAL
          // directory, reporting `creatable` through an occupied ancestor
          // that `fs.mkdirSync(root, { recursive: true })` can never create
          // through (it fails with ENOENT or ENOTDIR at runtime).
          let occupant = null;
          try {
            occupant = fs.lstatSync(parent);
          } catch (_) {
            occupant = null; // no readable directory entry at this component
          }
          if (occupant === null) {
            candidate = parent;
            continue;
          }
          // A directory entry OCCUPIES this component: the creation boundary
          // is found here, and the classification below decides on its
          // resolved truth instead of skipping past it.
          break;
        }
        if (reason === null) {
          // Resolve the occupied boundary THROUGH symlinks exactly as the
          // runtime recursive creation does: a valid symlink to a directory
          // is as traversable as the directory it resolves to, while a
          // dangling symlink (or any other occupant that does not resolve to
          // a directory) cannot host creation below it — the existing
          // sanitized `parent_not_a_directory` reason carries that truth.
          let parentStats = null;
          try {
            parentStats = fs.statSync(parent);
          } catch (_) {
            parentStats = null; // occupied but unresolvable (dangling symlink, link loop)
          }
          if (parentStats === null || !parentStats.isDirectory()) {
            reason = 'parent_not_a_directory';
          } else {
            fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
            usable = true;
            reason = 'creatable';
          }
        }
      }
    } catch (_) {
      // statSync/accessSync failures on the checked boundary itself: the
      // environment could not be established as usable (missing permission or
      // an unreadable path is only reachable for an existing boundary).
      usable = false;
      reason = state === 'exists' ? 'insufficient_permissions' : 'parent_insufficient_permissions';
    }
    return Object.freeze({
      id: entry.id,
      usable,
      reason
    });
  }));
}

// Deterministic payload projection. Inputs are DATA, never live probes, so
// the semantics are exhaustively provable without a database.
function buildHealthProjection({
  serverReady = true,
  evidencePersistenceLatched = false,
  postgresProbe = { reachable: true, migrationStatus: null },
  effectRoots = [],
  admissionMetrics = null,
  processRelease = null,
  includeUptime = false,
  configurationFailures = null
} = {}) {
  const configuration = configurationFailures || validateEnvironment(process.env);
  const configurationValid = configuration.ok === true;
  const roots = effectRoots.length > 0 ? effectRootReadiness(effectRoots) : [];
  const rootsUsable = roots.every(root => root.usable === true);
  const migration = postgresProbe.reachable
    ? classifyMigrationStatus(postgresProbe.migrationStatus)
    : { compatible: false, code: 'postgres_unreachable' };
  const migrationCompatible = postgresProbe.reachable && migration.compatible === true;

  // Readiness precedence: the terminal evidence latch first (parity with the
  // established fail-closed sequencing, where a persisted evidence failure
  // also clears startup readiness), then startup readiness, then
  // configuration, PostgreSQL/migrations, effect roots.
  let ready = serverReady && configurationValid && migrationCompatible && rootsUsable;
  if (evidencePersistenceLatched) ready = false;
  if (!serverReady) ready = false;

  let status;
  let reason = null;
  if (evidencePersistenceLatched) {
    status = 'degraded';
    reason = READINESS_REASON_CODES.EVIDENCE_PERSISTENCE_LATCHED;
  } else if (!serverReady) {
    status = 'starting';
  } else if (!configurationValid) {
    status = 'unready';
    reason = READINESS_REASON_CODES.CONFIGURATION_INVALID;
  } else if (!postgresProbe.reachable) {
    status = 'unready';
    reason = READINESS_REASON_CODES.POSTGRES_UNREACHABLE;
  } else if (!migrationCompatible) {
    status = 'unready';
    reason = READINESS_REASON_CODES.MIGRATIONS_INCOMPATIBLE;
  } else if (!rootsUsable) {
    status = 'unready';
    reason = READINESS_REASON_CODES.EFFECT_ROOT_UNUSABLE;
  } else {
    status = 'ok';
  }

  // Capacity is ALWAYS reported and NEVER alters readiness or the status.
  // The mutation-admission metrics keep their existing observation contract
  // (runtime/mutation-admission.js getMetrics) so operators see the same
  // bounded values as the operational summary.
  const payload = {
    projectionVersion: READINESS_PROJECTION_VERSION,
    status,
    alive: true,
    ready,
    capacity: {
      scope: 'process',
      mutationAdmission: admissionMetrics
    }
  };

  if (!ready) {
    payload.reason = reason;
    payload.readiness = {
      postgresql: postgresProbe.reachable ? 'reachable' : 'unreachable',
      migrations: postgresProbe.reachable
        ? {
            compatible: migration.compatible,
            code: migration.code,
            facts: migration.facts || null
          }
        : null,
      configuration: configurationValid ? { valid: true } : {
        valid: false,
        invalidSettings: configuration.failures.map(failure => failure.name).sort()
      },
      effectRoots: roots.map(root => ({ id: root.id, usable: root.usable })),
      evidencePersistence: evidencePersistenceLatched ? 'latched' : 'healthy'
    };
  }

  if (includeUptime) payload.uptime = Math.floor(process.uptime());
  if (processRelease) payload.processExecutionRelease = processRelease;

  return {
    statusCode: ready ? 200 : 503,
    ready,
    alive: true,
    status,
    reason,
    payload
  };
}

module.exports = {
  READINESS_PROJECTION_VERSION,
  READINESS_REASON_CODES,
  buildHealthProjection,
  classifyMigrationStatus,
  effectRootReadiness,
  probePostgresReadiness,
  sanitizePostgresProbeError
};
